import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContours, analyzeLogSignals, normalizeSearch } from './investigation.mjs';

const internal = overrides => ({ source: 'Закрытый контур', found: true, interaction: { id: 'x', send_at: null, type_code: 'REQ_AUDIT_INFO' }, registrations: [], ...overrides });
const external = overrides => ({ source: 'Открытый контур', found: false, ...overrides });

test('номер ищется с ведущими нулями, произвольный текст отклоняется', () => {
  assert.deepEqual(normalizeSearch('506'), { query: '0000000506', byId: false });
  assert.deepEqual(normalizeSearch('ЗИ/594/01С'), { query: 'ЗИ/594/01С', byId: false });
  assert.throws(() => normalizeSearch('506 OR 1=1'));
});

test('ожидание DELOM не объявляется окончательным сбоем и не заменяется MAIN_PDF', () => {
  const findings = analyzeContours(internal({ registrations: [
    { id: 'old', error_message: 'REGISTERED_FILES_MAIN_PDF_NOT_FOUND', terminal_status: 'FAILED_FINAL' },
    { id: 'new', error_code: 'REGISTERED_FILES_DOWNLOAD_TIMEOUT', error_message: 'reason=REGISTERED_FILES_DELOM_NOT_FOUND', terminal_status: null }
  ] }), external({}), 'request');
  assert.equal(findings.some(item => item.title === 'Не найден основной PDF'), false);
  assert.equal(findings.find(item => item.title === 'Не найден комплект DELOM').level, 'possible');
});

test('общий timeout без причины не трактуется как отсутствие PDF', () => {
  const findings = analyzeContours(internal({ registrations: [{ id: 'r', error_code: 'REGISTERED_FILES_DOWNLOAD_TIMEOUT', error_message: '', terminal_status: 'FAILED_FINAL' }] }), external({}), 'request');
  assert.equal(findings.some(item => item.title === 'Не найден основной PDF'), false);
  assert.equal(findings.some(item => item.title.includes('REGISTERED_FILES_DOWNLOAD_TIMEOUT')), true);
});

test('send_at без внешней карточки оставляет причину открытой', () => {
  const findings = analyzeContours(internal({ interaction: { send_at: '2026-10-01T10:00:00Z' } }), external({}), 'request');
  assert.equal(findings[0].level, 'possible');
  assert.match(findings[0].detail, /не доказывает сбой Kafka/);
});

test('недоступный внешний контур не считается отсутствием доставки', () => {
  const findings = analyzeContours(internal({}), external({ error: 'connection refused' }), 'request');
  assert.equal(findings.some(item => item.title === 'Доставка во внешний контур не подтверждена'), false);
  assert.equal(findings[0].level, 'unknown');
});

test('уведомлению не приписываются этапы ответа на запрос', () => {
  const findings = analyzeContours(internal({ interaction: { type_code: 'NOTICE_EVENT' } }), external({}), 'notice');
  assert.equal(findings.some(item => item.title === 'Маршрут уведомления зависит от его типа'), true);
});

test('сигнал ограничения Kafka остаётся гипотезой с адресной строкой', () => {
  const result = analyzeLogSignals({ status: 'ok', entries: [{ namespace: 'development', pod: 'flow-1', lines: ['interactionId=x RecordTooLargeException'] }] });
  assert.equal(result[0].level, 'possible');
  assert.match(result[0].evidence.join(' '), /flow-1/);
});

test('недоступность логов видна в выводах', () => {
  const result = analyzeLogSignals({ status: 'unavailable', reason: 'Не задан LK_KUBECONFIG.', entries: [] });
  assert.equal(result[0].level, 'unknown');
});
