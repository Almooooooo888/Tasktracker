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
  { kind: 'internal', name: 'Закрытый контур', stand: process.env.LK_STAND_INTERNAL || localSettings.internalStand || process.env.LK_DB_INTERNAL || localSettings.internalDatabase || 'не настроен', database: process.env.LK_DB_INTERNAL || localSettings.internalDatabase, schema: process.env.LK_SCHEMA_INTERNAL || localSettings.internalSchema },
  { kind: 'external', name: 'Открытый контур', stand: process.env.LK_STAND_EXTERNAL || localSettings.externalStand || process.env.LK_DB_EXTERNAL || localSettings.externalDatabase || 'не настроен', database: process.env.LK_DB_EXTERNAL || localSettings.externalDatabase, schema: process.env.LK_SCHEMA_EXTERNAL || localSettings.externalSchema }
];
const PODS = Array.isArray(localSettings.podGroups) ? localSettings.podGroups : [];

export function normalizeSearch(value) {
  let query = String(value || '').trim();
  if (/^https?:\/\//i.test(query)) {
    try { const url = new URL(query); query = url.href.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] || ''; }
    catch { query = ''; }
  }
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
      to_jsonb(i)->>'created_by' AS created_by, to_jsonb(i)->>'respond_by' AS respond_by,
      to_jsonb(i)->>'event_id' AS event_id, to_jsonb(i)->>'event_object_id' AS event_object_id,
      to_jsonb(t)->>'code' AS type_code,
      to_jsonb(t)->>'audit_interaction_classification' AS kind,
      to_jsonb(i)->>'submission_form_id' AS submission_form_id,
      to_jsonb(i)->>'status_id' AS current_status_id
      FROM ${schema}.audit_interaction i
      LEFT JOIN ${schema}.audit_interaction_type t ON t.id = i.audit_interaction_type_id
      WHERE ${match} ORDER BY i.created_at DESC LIMIT 3`, [search.query]);
    if (found.rows.length !== 1) {
      await client.query('COMMIT');
      return { source: source.name, stand: source.stand, database: source.database, found: false, ambiguous: found.rows.length > 1 };
    }
    const interaction = found.rows[0];
    const id = interaction.id;
    const [history, files, answers] = await Promise.all([
      client.query(`SELECT COALESCE(to_jsonb(h)->>'changed_at',to_jsonb(h)->>'created_at') AS changed_at, s.code AS status_code, s.name AS status_name
        FROM ${schema}.audit_interaction_status_history h
        LEFT JOIN ${schema}.audit_interaction_status s ON s.id::text = COALESCE(to_jsonb(h)->>'to_status_id', to_jsonb(h)->>'status_id')
        WHERE COALESCE(to_jsonb(h)->>'interaction_id', to_jsonb(h)->>'audit_interaction_id') = $1
        ORDER BY COALESCE(to_jsonb(h)->>'changed_at',to_jsonb(h)->>'created_at') LIMIT 100`, [id]),
      client.query(`SELECT f.id, f.original_name, f.file_type, f.created_at,
        to_jsonb(f)->>'file_size' AS file_size, to_jsonb(f)->>'type' AS mime_type
        FROM ${schema}.audit_interaction_file link JOIN ${schema}.file f ON f.id = link.file_id
        WHERE link.audit_interaction_id = $1::uuid ORDER BY f.created_at LIMIT 100`, [id]),
      client.query(`SELECT a.id, to_jsonb(a)->>'sequence_number' AS sequence_number,
        to_jsonb(a)->>'created_at' AS created_at, to_jsonb(a)->>'updated_at' AS updated_at,
        to_jsonb(a)->>'status' AS status, to_jsonb(a)->>'send_at' AS send_at
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
    let form = null;
    if (interaction.submission_form_id && UUID.test(interaction.submission_form_id)) {
      const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'form_submissions'`, [schema]);
      if (tables.rows.length) {
        const result = await client.query(`SELECT id, to_jsonb(f)->>'form_template_id' AS template_id,
          to_jsonb(f)->>'submitted_at' AS submitted_at, to_jsonb(f)->>'created_at' AS created_at
          FROM ${schema}.form_submissions f WHERE id = $1::uuid LIMIT 1`, [interaction.submission_form_id]);
        form = result.rows[0] || null;
      }
    }
    await client.query('COMMIT');
    return { source: source.name, stand: source.stand, database: source.database, found: true, interaction, history: history.rows, files: files.rows, answers: answers.rows, registrations, form };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    return { source: source.name, stand: source.stand, database: source.database, found: false, error: error.message };
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
    findings.push(finding('unknown', internal.error && external.error ? 'Не удалось проверить карточку' : 'Карточка не найдена в доступных данных', 'Проверь номер и доступность настроенных контуров. Ошибка подключения источника не доказывает отсутствие карточки.', [internal.error, external.error].filter(Boolean)));
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

export function logRange(contours, minutes, now = Date.now()) {
  const stamps = contours.flatMap(contour => contour.found ? [
    contour.interaction?.created_at, contour.interaction?.updated_at, contour.interaction?.send_at,
    ...(contour.history || []).map(row => row.changed_at),
    ...(contour.files || []).map(row => row.created_at),
    ...(contour.answers || []).flatMap(row => [row.created_at, row.updated_at, row.send_at]),
    ...(contour.registrations || []).flatMap(row => [row.created_at, row.updated_at])
  ] : []).map(value => Date.parse(value)).filter(Number.isFinite);
  const margin = minutes * 60000;
  return { start: new Date(Math.max(0, (stamps.length ? Math.min(...stamps) : now) - margin)).toISOString(),
    end: new Date(Math.min(now, (stamps.length ? Math.max(...stamps) : now) + margin)).toISOString() };
}

export function matchesLogId(line, ids) {
  const lower = line.toLowerCase();
  return ids.some(value => {
    const id = String(value).toLowerCase();
    if (!lower.includes(id)) return false;
    if (!/^\d+$/.test(id)) return true;
    let at = lower.indexOf(id);
    while (at !== -1) {
      if (!/\d/.test(lower[at - 1] || '') && !/\d/.test(lower[at + id.length] || '')) return true;
      at = lower.indexOf(id, at + 1);
    }
    return false;
  });
}

async function readLogs(ids, range, connection) {
  const kubeconfig = connection.kubeconfig || process.env.LK_KUBECONFIG || localSettings.kubeconfig;
  if (!kubeconfig) return { status: 'unavailable', reason: 'Не задан LK_KUBECONFIG.', entries: [] };
  if (!PODS.length) return { status: 'unavailable', reason: 'Не настроены namespace и префиксы pod для поиска логов.', entries: [] };
  const executable = process.env.LK_KUBECTL || 'kubectl';
  const base = ['--kubeconfig', kubeconfig];
  if (process.env.LK_KUBE_CONTEXT) base.push('--context', process.env.LK_KUBE_CONTEXT);
  const entries = [], errors = [];
  let scannedPods = 0, omittedPods = 0, newerPods = 0;
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
      newerPods += pods.filter(pod => Date.parse(pod.metadata?.creationTimestamp) > Date.parse(range.end)).length;
      if(!pods.length)errors.push(`${group.namespace}: подходящие работающие pod не найдены.`);
    } catch (error) { errors.push(`${group.namespace}: ${error.message}`); continue; }
    await Promise.all(pods.map(async pod => {
      const name = pod.metadata.name;
      try {
        const result = await runFile(executable, [...base, '-n', group.namespace, 'logs', name, `--since-time=${range.start}`, '--timestamps=true', '--tail=5000'], { windowsHide: true, timeout: 20000, maxBuffer: 6 * 1024 * 1024 });
        const matching = result.stdout.split(/\r?\n/).filter(line => {
          const stamp = Date.parse(line.split(' ',1)[0]);
          return (!Number.isFinite(stamp) || stamp <= Date.parse(range.end)) && matchesLogId(line, ids);
        }).slice(0, 60);
        if (matching.length) entries.push({ namespace: group.namespace, pod: name, lines: matching.map(line => redact(line.slice(0, 1200))) });
      } catch (error) { errors.push(`${group.namespace}/${name}: ${error.message}`); }
    }));
  }
  const notes=[...errors.slice(0,4)];if(omittedPods)notes.push(`Не проверено pod: ${omittedPods}.`);if(newerPods)notes.push(`Pod запущены после исследуемого периода: ${newerPods}; их прежние экземпляры недоступны.`);
  return { status: notes.length ? 'partial' : 'ok', reason: notes.join(' · '), entries, range, tailPerPod: 5000, scannedPods, omittedPods, newerPods,
    coverage: 'Проверены только текущие pod и последние 5000 строк каждого с начала периода; удалённые pod и архив логов не доступны этому поиску.' };
}

export function detectKind(interaction) {
  const actual = String(interaction?.kind || interaction?.type_code || '').toLowerCase();
  if (/уведом|notice|^notif[_-]/.test(actual)) return 'notice';
  if (/запрос|request|^req[_-]/.test(actual)) return 'request';
  return 'unknown';
}

export function buildJourney(contours, logs, kind) {
  const events=[];
  for(const contour of contours.filter(item=>item.found)){
    const base={source:contour.source,database:contour.database,stand:contour.stand};
    const push=(time,stage,detail,evidence)=>{if(time&&Number.isFinite(Date.parse(time)))events.push({...base,time,stage,detail,evidence})};
    const item=contour.interaction;
    if(contour.form)push(contour.form.submitted_at||contour.form.created_at,'Форма отправлена',`Форма ${contour.form.id}; шаблон ${contour.form.template_id||'не установлен'}`,`БД ${contour.database}: form_submissions.id=${contour.form.id}`);
    push(item.created_at,kind==='notice'?'Уведомление создано':'Запрос создан',`Номер ${item.sequence_number||'не указан'}`,`БД ${contour.database}: audit_interaction.id=${item.id}`);
    for(const row of contour.history||[])push(row.changed_at,'Смена статуса',row.status_name||row.status_code||'Код статуса не получен',`БД ${contour.database}: audit_interaction_status_history`);
    for(const row of contour.files||[])push(row.created_at,'Файл прикреплён',`${row.original_name||row.id} · ${row.file_type||row.mime_type||'тип не указан'}`,`БД ${contour.database}: file.id=${row.id}`);
    for(const row of contour.registrations||[])push(row.updated_at||row.created_at,'САДЭД',`${row.status||row.integration_status||'статус не указан'}${row.error_code?' · '+row.error_code:''}`,`БД ${contour.database}: saded_registration.id=${row.id}`);
    if(item.send_at)push(item.send_at,'Отправка отмечена','В карточке заполнено send_at; получение другим контуром проверяется отдельно.',`БД ${contour.database}: audit_interaction.send_at`);
    for(const row of contour.answers||[])push(row.created_at,'Ответ создан',`Ответ ${row.sequence_number||row.id}${row.status?' · '+row.status:''}`,`БД ${contour.database}: audit_interaction_answer.id=${row.id}`);
  }
  for(const entry of logs.entries||[])for(const line of entry.lines){const time=line.split(' ',1)[0];if(Number.isFinite(Date.parse(time)))events.push({time,stage:'Лог Kubernetes',detail:line.slice(0,500),source:`${entry.namespace}/${entry.pod}`,database:null,stand:null,evidence:`Kubernetes ${entry.namespace}/${entry.pod}`})}
  events.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const found=contours.filter(item=>item.found),internal=found.find(item=>item.source==='Закрытый контур'),external=found.find(item=>item.source==='Открытый контур');
  const nextStep=!found.length?'Уточнить номер/UUID и доступность настроенных БД.':internal&&!external?(internal.interaction.send_at?'Проверить перенос в открытый контур по UUID и адресным логам.':'Проверить этап перед отправкой в САДЭД/Flow по истории и адресным логам.') : external&&!internal?'Проверить соответствующую карточку закрытого контура по UUID и возможную разницу номеров.':'Сверить итоговый статус, ответ и файлы в обоих контурах; отсутствие ошибок в доступных логах не доказывает полный маршрут.';
  return {stands:found.map(item=>({stand:item.stand,contour:item.source,database:item.database})),searchedStands:contours.map(item=>({stand:item.stand,contour:item.source,database:item.database,available:!item.error})),events:events.slice(0,160),omittedEvents:Math.max(0,events.length-160),lastConfirmed:events.at(-1)||null,nextStep};
}

export async function investigate({ kind, number, minutes = 180, connection = {} }) {
  if (!['auto','request', 'notice'].includes(kind)) throw new Error('Выбери автоматическое определение, запрос или уведомление.');
  const search = normalizeSearch(number);
  const windowMinutes = Math.max(1, Math.min(1440, Number(minutes) || 180));
  let [internal, external] = await Promise.all(SOURCES.map(source => readContour(source, search, connection)));
  if(internal.found&&!external.found&&!external.error&&!external.ambiguous)external={...await readContour(SOURCES[1],{query:internal.interaction.id,byId:true},connection),matchedBy:'UUID закрытого контура'};
  else if(external.found&&!internal.found&&!internal.error&&!internal.ambiguous)internal={...await readContour(SOURCES[0],{query:external.interaction.id,byId:true},connection),matchedBy:'UUID открытого контура'};
  const current = internal.interaction || external.interaction;
  const detectedKind=detectKind(current);
  if (current) {
    if (kind !== 'auto' && detectedKind !== 'unknown' && kind !== detectedKind) {
      throw new Error(`Номер относится к типу «${current.kind || current.type_code || 'неизвестен'}». Переключи вид карточки.`);
    }
  }
  const effectiveKind=kind==='auto'?detectedKind:kind;
  const ids = [...new Set([search.query,...[internal,external].flatMap(contour=>[contour.interaction?.id,contour.interaction?.sequence_number,contour.interaction?.submission_form_id,contour.interaction?.event_id,contour.interaction?.event_object_id]),
    ...(internal.registrations || []).flatMap(item => [item.id, item.isn_prj && String(item.isn_prj), item.registered_isn_doc && String(item.registered_isn_doc)]),
    ...[internal, external].flatMap(contour => [...(contour.files || []).map(file => file.id), ...(contour.answers || []).map(answer => answer.id)])
  ].filter(value=>String(value||'').length>=6))].slice(0, 60);
  const range=logRange([internal,external],windowMinutes);
  const logs = current ? await readLogs(ids, range, connection) : { status: 'skipped', reason: 'Карточка не найдена.', entries: [] };
  const findings = [...analyzeContours(internal, external, effectiveKind), ...analyzeLogSignals(logs)];
  if(current&&detectedKind==='unknown')findings.push(finding('unknown','Тип обращения не определён','Проверь классификацию карточки в БД и интерфейсе; этапы запроса и уведомления автоматически не приравниваются.',[`type_code=${current.type_code||'не указан'}`]));
  const journey=buildJourney([internal,external],logs,effectiveKind);
  return { checkedAt: new Date().toISOString(), kind: effectiveKind, searched: search.query, interactionId: current?.id || null, contours: [internal, external], findings, logs, journey, correlatedIds:ids.length };
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
