import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const runFile = promisify(execFile);
let localSettings = {};
try { localSettings = JSON.parse(readFileSync(new URL('./diagnostics.local.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
export const diagnosticDefaults = {
  pgHost: process.env.LK_PG_HOST || localSettings.pgHost || '',
  pgUser: process.env.LK_PG_USER || localSettings.pgUser || '',
  kubeconfig: process.env.LK_KUBECONFIG || localSettings.kubeconfig || ''
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMBER = /^[0-9]{1,20}$/;
const DOCUMENT_NUMBER = /^[\p{L}\p{N}/._ -]{1,80}$/u;
const SOURCES = [
  { kind: 'internal', name: 'Закрытый контур', database: process.env.LK_DB_INTERNAL || localSettings.internalDatabase, schema: process.env.LK_SCHEMA_INTERNAL || localSettings.internalSchema },
  { kind: 'external', name: 'Открытый контур', database: process.env.LK_DB_EXTERNAL || localSettings.externalDatabase, schema: process.env.LK_SCHEMA_EXTERNAL || localSettings.externalSchema }
];
const PODS = Array.isArray(localSettings.podGroups) ? localSettings.podGroups : [];

export function normalizeSearch(value) {
  const query = String(value || '').trim();
  if (UUID.test(query)) return { query: query.toLowerCase(), byId: true };
  if (NUMBER.test(query)) return { query: query.padStart(10, '0'), byId: false };
  if (DOCUMENT_NUMBER.test(query)) return { query, byId: false };
  throw new Error('Введи номер запроса/уведомления или полный UUID карточки.');
}

function databaseConfig(source, connection = {}) {
  const host = connection.pgHost || process.env.LK_PG_HOST || localSettings.pgHost;
  const user = connection.pgUser || process.env.LK_PG_USER || localSettings.pgUser;
  const password = connection.pgPassword || process.env.LK_PG_PASSWORD;
  if (!host || !user || !password || !source.database || !source.schema) throw new Error('База не настроена: нужны хост, read-only учётная запись, пароль, имена БД и схем обоих контуров.');
  if (!/^[a-z][a-z0-9_]*$/i.test(source.schema)) throw new Error('Некорректное имя схемы БД.');
  return {
    host, user, password, database: source.database,
    port: Number(process.env.LK_PG_PORT || 5432),
    connectionTimeoutMillis: 8000,
    application_name: 'taskboard-investigation-readonly',
    options: '-c default_transaction_read_only=on -c statement_timeout=15000'
  };
}

async function readContour(source, search, connection) {
  let pool, client;
  try {
    pool = new pg.Pool({ ...databaseConfig(source, connection), max: 1 });
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const schema = source.schema;
    const match = search.byId ? 'i.id = $1::uuid' : source.kind === 'internal'
      ? `(i.sequence_number = $1 OR EXISTS (SELECT 1 FROM ${schema}.saded_registration r WHERE r.interaction_id = i.id AND r.free_num = $1))`
      : 'i.sequence_number = $1';
    const found = await client.query(`SELECT i.id, i.sequence_number,
      to_jsonb(i)->>'name' AS name, to_jsonb(i)->>'created_at' AS created_at,
      to_jsonb(i)->>'updated_at' AS updated_at, to_jsonb(i)->>'send_at' AS send_at,
      to_jsonb(t)->>'code' AS type_code,
      to_jsonb(t)->>'audit_interaction_classification' AS kind,
      to_jsonb(i)->>'submission_form_id' AS submission_form_id,
      to_jsonb(i)->>'status_id' AS current_status_id
      FROM ${schema}.audit_interaction i
      LEFT JOIN ${schema}.audit_interaction_type t ON t.id = i.audit_interaction_type_id
      WHERE ${match} ORDER BY i.created_at DESC LIMIT 3`, [search.query]);
    if (found.rows.length !== 1) {
      await client.query('COMMIT');
      return { source: source.name, found: false, ambiguous: found.rows.length > 1 };
    }
    const interaction = found.rows[0];
    const id = interaction.id;
    const [history, files, answers] = await Promise.all([
      client.query(`SELECT COALESCE(to_jsonb(h)->>'changed_at',to_jsonb(h)->>'created_at') AS changed_at, s.code AS status_code, s.name AS status_name
        FROM ${schema}.audit_interaction_status_history h
        LEFT JOIN ${schema}.audit_interaction_status s ON s.id::text = COALESCE(to_jsonb(h)->>'to_status_id', to_jsonb(h)->>'status_id')
        WHERE COALESCE(to_jsonb(h)->>'interaction_id', to_jsonb(h)->>'audit_interaction_id') = $1
        ORDER BY COALESCE(to_jsonb(h)->>'changed_at',to_jsonb(h)->>'created_at') LIMIT 100`, [id]),
      client.query(`SELECT f.id, f.original_name, f.file_type, f.created_at
        FROM ${schema}.audit_interaction_file link JOIN ${schema}.file f ON f.id = link.file_id
        WHERE link.audit_interaction_id = $1::uuid ORDER BY f.created_at LIMIT 100`, [id]),
      client.query(`SELECT a.id, to_jsonb(a)->>'sequence_number' AS sequence_number,
        to_jsonb(a)->>'created_at' AS created_at, to_jsonb(a)->>'updated_at' AS updated_at
        FROM ${schema}.audit_interaction_answer a
        WHERE COALESCE(to_jsonb(a)->>'interaction_id', to_jsonb(a)->>'audit_interaction_id') = $1
        ORDER BY to_jsonb(a)->>'created_at' LIMIT 100`, [id])
    ]);
    const lastStatus = history.rows.at(-1);
    interaction.status_code = lastStatus?.status_code || null;
    interaction.status_name = lastStatus?.status_name || null;
    if (!lastStatus && interaction.current_status_id) {
      const status = await client.query(`SELECT code, name FROM ${schema}.audit_interaction_status WHERE id = $1::uuid`, [interaction.current_status_id]);
      interaction.status_code = status.rows[0]?.code || null;
      interaction.status_name = status.rows[0]?.name || null;
    }
    delete interaction.current_status_id;
    let registrations = [];
    if (source.kind === 'internal') {
      const result = await client.query(`SELECT id, status, integration_status, free_num, isn_prj,
        registered_isn_doc, error_code, error_message, terminal_status, attempt_no, created_at, updated_at
        FROM ${schema}.saded_registration WHERE interaction_id = $1::uuid
        ORDER BY created_at LIMIT 20`, [id]);
      registrations = result.rows;
    }
    await client.query('COMMIT');
    return { source: source.name, found: true, interaction, history: history.rows, files: files.rows, answers: answers.rows, registrations };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return { source: source.name, found: false, error: error.message };
  } finally {
    client?.release();
    if (pool) await pool.end();
  }
}

function finding(level, title, detail, evidence) { return { level, title, detail, evidence }; }

export function analyzeContours(internal, external, kind) {
  const findings = [];
  const current = internal.interaction || external.interaction;
  if (!current) {
    findings.push(finding('unknown', 'Карточка не найдена в доступных данных', 'Проверь номер и выбранный контур. Ошибка подключения одного из источников не доказывает отсутствие карточки.', [internal.error, external.error].filter(Boolean)));
    return findings;
  }
  if (internal.error || external.error) findings.push(finding('unknown', 'Проверка контуров неполная', 'Один из источников недоступен; вывод о доставке по нему делать нельзя.', [internal.error ? 'Ошибка закрытого контура' : '', external.error ? 'Ошибка открытого контура' : ''].filter(Boolean)));
  if (internal.found && external.found) {
    findings.push(finding('confirmed', 'Карточка есть в обоих контурах', 'Наличие записей в обеих БД подтверждено на момент проверки. Доступность карточки в интерфейсе и весь маршрут Kafka отдельно не проверены.', ['закрытая БД: карточка найдена', 'открытая БД: карточка найдена']));
  } else if (internal.found && !external.found && !external.error) {
    const sent = Boolean(internal.interaction.send_at);
    findings.push(finding(sent ? 'possible' : 'confirmed', sent ? 'Отправка отмечена, внешняя карточка не найдена' : 'Доставка во внешний контур не подтверждена', sent ? 'Нужно сверить обработку во внешнем контуре и время снимка. Само по себе это не доказывает сбой Kafka.' : 'В закрытом контуре нет send_at, а во внешней БД карточка не найдена. Причину остановки определяют дальнейшие записи интеграции и логи.', ['закрытая БД: send_at=' + (internal.interaction.send_at || 'пусто'), 'открытая БД: карточка не найдена']));
  } else if (!internal.found && !internal.error && external.found) {
    findings.push(finding('possible', 'Внешняя карточка есть, внутренняя не найдена', 'Проверь стенд и номер. Это расхождение снимков БД; причина не установлена.', ['закрытая БД: карточка не найдена', 'открытая БД: карточка найдена']));
  }
  for (const registration of (internal.registrations || []).slice(-1)) {
    if (registration.registered_isn_doc) findings.push(finding('confirmed', 'Документ зарегистрирован в САДЭД', 'В записи интеграции есть идентификатор зарегистрированного документа. Это не означает, что итоговые файлы получены и карточка доставлена во внешний контур.', [`registrationId=${registration.id}`, `registered_isn_doc=${registration.registered_isn_doc}`]));
    const detail = String(registration.error_message || '');
    const reason = detail.match(/REGISTERED_FILES_(MAIN_PDF|DELOM)_NOT_FOUND/)?.[0];
    const final = String(registration.terminal_status || '').toUpperCase() === 'FAILED_FINAL';
    if (reason) findings.push(finding(final ? 'confirmed' : 'possible', reason.endsWith('MAIN_PDF_NOT_FOUND') ? 'Не найден основной PDF' : 'Не найден комплект DELOM', final ? 'Загрузка итоговых файлов завершилась с ошибкой. Причина отсутствия файла в САДЭД по этой записи не устанавливается.' : 'В интеграции зафиксировано ожидание файла. Повторная обработка ещё возможна; итоговый сбой не подтверждён.', [`закрытая БД: registrationId=${registration.id}`, `error_message: ${reason}`, `terminal_status=${registration.terminal_status || 'не указан'}`]));
    else if (registration.error_code) findings.push(finding(final ? 'confirmed' : 'possible', `Интеграция САДЭД: ${registration.error_code}`, final ? 'Запись помечена как окончательно неуспешная.' : 'Нужны подробная ошибка задачи и адресные логи для причины.', [`закрытая БД: registrationId=${registration.id}`, `error_code=${registration.error_code}`]));
  }
  if (kind === 'notice') findings.push(finding('unknown', 'Маршрут уведомления зависит от его типа', 'К уведомлению не применяются автоматически этапы ответа на запрос. Смотри фактическую историю статусов этой карточки.', [`type_code=${current.type_code || 'не указан'}`]));
  if (!findings.some(item => item.level === 'possible' || item.level === 'unknown') && findings.length === 0) findings.push(finding('unknown', 'Явная проблема не обнаружена', 'Это результат только доступных источников и выбранного окна логов.', []));
  return findings;
}

export function analyzeLogSignals(logs) {
  if (logs.status === 'unavailable' || logs.status === 'skipped') return [finding('unknown', 'Логи не проверены', logs.reason || 'Источник логов недоступен.', [])];
  const rules = [
    { pattern: /RecordTooLarge|max\.request\.size|message\.max\.bytes/i, title: 'Возможное превышение размера сообщения', detail: 'Строка лога указывает на ограничение размера. Проверь соответствующий messageId и результат повторной отправки.' },
    { pattern: /fk_form_submissions_template|form_template_id.*absent|отсутствует в таблице.*form_templates/i, title: 'Возможная проблема синхронизации шаблона', detail: 'Найдено указание на недостающий шаблон. Сверь форму и шаблон в обоих контурах.' },
    { pattern: /401 Unauthorized|403 Forbidden|authentication.*failed/i, title: 'Возможная ошибка доступа', detail: 'Найден ответ авторизации. Нужно проверить вызываемый сервис, пользователя и итог повтора.' },
    { pattern: /Record in retry|Seeking to offset|retry scheduled/i, title: 'Найдена повторная обработка', detail: 'Повтор не равен окончательному сбою; проверь более поздний успешный или финальный исход.' }
  ];
  const result = [];
  for (const rule of rules) {
    for (const entry of logs.entries || []) {
      const line = entry.lines.find(value => rule.pattern.test(value));
      if (line) { result.push(finding('possible', rule.title, rule.detail, [`${entry.namespace}/${entry.pod}`, line.slice(0, 500)])); break; }
    }
  }
  if (logs.status === 'partial') result.push(finding('unknown', 'Часть логов недоступна', logs.reason || 'Не все pod ответили.', []));
  return result;
}

function redact(line) {
  return line.replace(/(Bearer\s+)\S+/gi, '$1[скрыто]')
    .replace(/(PRIVATE-TOKEN\s*[:=]\s*)\S+/gi, '$1[скрыто]')
    .replace(/(password\s*[:=]\s*)\S+/gi, '$1[скрыто]');
}

async function readLogs(ids, minutes, connection) {
  const kubeconfig = connection.kubeconfig || process.env.LK_KUBECONFIG || localSettings.kubeconfig;
  if (!kubeconfig) return { status: 'unavailable', reason: 'Не задан LK_KUBECONFIG.', entries: [] };
  if (!PODS.length) return { status: 'unavailable', reason: 'Не настроены namespace и префиксы pod для поиска логов.', entries: [] };
  const executable = process.env.LK_KUBECTL || 'kubectl';
  const base = ['--kubeconfig', kubeconfig];
  if (process.env.LK_KUBE_CONTEXT) base.push('--context', process.env.LK_KUBE_CONTEXT);
  const entries = [], errors = [];
  let scannedPods = 0, omittedPods = 0;
  for (const group of PODS) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(group.namespace) || !Array.isArray(group.prefixes) || !group.prefixes.every(prefix => /^[a-z0-9][a-z0-9-]*$/.test(prefix))) {
      errors.push('Некорректные правила поиска pod.');
      continue;
    }
    let pods;
    try {
      const result = await runFile(executable, [...base, '-n', group.namespace, 'get', 'pods', '-o', 'json'], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      const eligible = JSON.parse(result.stdout).items.filter(item => item.status?.phase === 'Running' && group.prefixes.some(prefix => (item.metadata?.name || '').startsWith(prefix))).sort((a,b) => String(b.metadata?.creationTimestamp).localeCompare(String(a.metadata?.creationTimestamp)));
      omittedPods += Math.max(0, eligible.length - 8);
      pods = eligible.slice(0, 8);
      scannedPods += pods.length;
    } catch (error) { errors.push(`${group.namespace}: ${error.message}`); continue; }
    await Promise.all(pods.map(async pod => {
      const name = pod.metadata.name;
      try {
        const result = await runFile(executable, [...base, '-n', group.namespace, 'logs', name, `--since=${minutes}m`, '--timestamps=true', '--tail=2000'], { windowsHide: true, timeout: 20000, maxBuffer: 3 * 1024 * 1024 });
        const matching = result.stdout.split(/\r?\n/).filter(line => ids.some(id => line.toLowerCase().includes(id.toLowerCase()))).slice(0, 40);
        if (matching.length) entries.push({ namespace: group.namespace, pod: name, lines: matching.map(line => redact(line.slice(0, 1200))) });
      } catch (error) { errors.push(`${group.namespace}/${name}: ${error.message}`); }
    }));
  }
  return { status: errors.length || omittedPods ? 'partial' : 'ok', reason: errors.length ? errors.slice(0, 4).join(' · ') : omittedPods ? `Не проверено pod: ${omittedPods}.` : '', entries, windowMinutes: minutes, tailPerPod: 2000, scannedPods, omittedPods };
}

export async function investigate({ kind, number, minutes = 180, connection = {} }) {
  if (!['request', 'notice'].includes(kind)) throw new Error('Выбери запрос или уведомление.');
  const search = normalizeSearch(number);
  const windowMinutes = Math.max(1, Math.min(1440, Number(minutes) || 180));
  const [internal, external] = await Promise.all(SOURCES.map(source => readContour(source, search, connection)));
  const current = internal.interaction || external.interaction;
  if (current) {
    const actual = String(current.kind || '').toLowerCase();
    if (kind === 'request' && actual !== 'запрос' || kind === 'notice' && actual !== 'уведомление') {
      throw new Error(`Номер относится к типу «${current.kind || current.type_code || 'неизвестен'}». Переключи вид карточки.`);
    }
  }
  const ids = [...new Set([current?.id, current?.sequence_number, current?.submission_form_id,
    ...(internal.registrations || []).flatMap(item => [item.id, item.isn_prj && String(item.isn_prj), item.registered_isn_doc && String(item.registered_isn_doc)]),
    ...[internal, external].flatMap(contour => [...(contour.files || []).map(file => file.id), ...(contour.answers || []).map(answer => answer.id)])
  ].filter(Boolean))].slice(0, 60);
  const logs = current ? await readLogs(ids, windowMinutes, connection) : { status: 'skipped', reason: 'Карточка не найдена.', entries: [] };
  const findings = [...analyzeContours(internal, external, kind), ...analyzeLogSignals(logs)];
  return { checkedAt: new Date().toISOString(), kind, searched: search.query, interactionId: current?.id || null, contours: [internal, external], findings, logs };
}

export async function checkDatabaseConnection(connection) {
  const pool = new pg.Pool({ ...databaseConfig(SOURCES[0], connection), max: 1 });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query('SELECT 1');
    await client.query('COMMIT');
  } catch(error) {
    if(client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}
