#!/usr/bin/env node
/**
 * AD-O6 (ep6 entry 13): доставляющий канал алертов — host-receiver (systemd на хосте).
 *
 * alertmanager (compose, backend-сеть) → webhook POST /alerts →
 * строка JSONL в /var/log/neurocenter/alerts.jsonl (файл 0600, каталог 0700) + journald.
 * «Доставлено» = запись в файл/journal с меткой времени (docs/implementation-readiness.md
 * P0-RES: «файл Prometheus rules не является доставленным alert»); resolve-события
 * доставляются (строка со status:"resolved" при снятии алерта).
 *
 * /metrics (scrape job alert-receiver в prometheus.yml):
 *   neurocenter_alert_receiver_up            — heartbeat gauge (1 = жив);
 *   neurocenter_alerts_received_total{status} — счётчики доставленных firing/resolved;
 *   neurocenter_edge_cert_days_to_expiry     — AD-OP-7: дней до истечения edge-сертификата,
 *     пересчитывается из CERT_PATH при каждом scrape (ротация видна без перезапуска);
 *     файл отсутствует/не читается → NaN (правило cert-expiry не срабатывает ложно,
 *     receiver_up остаётся 1 — канал жив, а сертификат неизвестен).
 *
 * /ready — readiness-проверка (systemd/docker exec).
 *
 * Зависимостей нет: только модули node:*. Запускается systemd-юнитом
 * deploy/production/alert-receiver.service (User=neurocenter-operator, Restart=always)
 * — в compose НЕ развёртывается. Канал down = neurocenter_alert_receiver_up исчезает из
 * scrape → правило NeurocenterAlertReceiverDown (up{job="alert-receiver"} == 0).
 *
 * Переменные окружения:
 *   ALERTS_FILE         — путь JSONL (default /var/log/neurocenter/alerts.jsonl);
 *   CERT_PATH           — edge-сертификат PEM (default /srv/neurocenter/config/tls/edge-cert.pem;
 *                          в юните задаётся актуальным TLS_CERT_FILE из production .env);
 *   ALERT_RECEIVER_PORT — порт HTTP (default 9111; обязан совпадать с alertmanager.yml
 *                          и prometheus.yml);
 *   ALERT_RECEIVER_HOST — адрес bind (default 0.0.0.0 — достижим из backend-моста
 *                          через host-gateway; наружу порт не публикуется).
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ALERTS_FILE = '/var/log/neurocenter/alerts.jsonl';
export const DEFAULT_CERT_PATH = '/srv/neurocenter/config/tls/edge-cert.pem';
export const DEFAULT_PORT = 9111;
export const DEFAULT_HOST = '0.0.0.0';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Fail-fast на старте: каталог alerts.jsonl обязан существовать (0700) и быть
 * writable — иначе канал доставки мёртв, и это должно быть видно сразу, а не
 * первым потерянным алертом. Ошибка — с путём и кодом для journal.
 */
export async function assertAlertsFileWritable(alertsFile) {
    const dir = path.dirname(alertsFile);
    try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const probe = path.join(dir, '.alert-receiver-probe-' + process.pid);
        await writeFile(probe, '', { mode: 0o600 });
        await unlink(probe);
    } catch (error) {
        throw new Error(
            'Канал алертов недоступен: нельзя писать ' +
                alertsFile +
                ' (' +
                (error.code ?? error.message) +
                '). Каталог ' +
                dir +
                ' должен существовать (0700) и быть writable для User=neurocenter-operator (alert-receiver.service).',
        );
    }
}

/**
 * Дней до истечения edge-сертификата из PEM (minимальный DER-парсер notAfter,
 * без зависимостей). Число дней, > 0; NaN — файл нет / не читается / не парсится.
 */
export function daysToExpiry(certPath) {
    try {
        // /metrics — редкий caller, файл мал: sync-чтение допустимо.
        const der = pemToDer(readFileSync(certPath, 'utf8'));
        return (certNotAfterMs(der) - Date.now()) / 86400000;
    } catch {
        return NaN;
    }
}

function pemToDer(pem) {
    const match = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
    if (!match) throw new Error('не PEM-сертификат');
    const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    if (der.length < 8) throw new Error('пустой DER');
    return der;
}

/** DER: длина элемента (короткая/длинная форма). Возвращает [length, index-начала-тела]. */
function derReadLength(buf, i) {
    if (i >= buf.length) throw new Error('обрыв DER');
    const first = buf[i];
    if (first < 0x80) return [first, i + 1];
    const count = first & 0x7f;
    if (count === 0) throw new Error('indefinite length недопустима в DER');
    if (count > 4 || i + 1 + count > buf.length) throw new Error('некорректная длина DER');
    let len = 0;
    for (let k = 1; k <= count; k++) len = len * 256 + buf[i + k];
    return [len, i + 1 + count];
}

/** DER: пропустить один элемент (тег + длина + тело), вернуть индекс за элементом. */
function derSkip(buf, i) {
    const [len, bodyStart] = derReadLength(buf, i + 1);
    const end = bodyStart + len;
    if (end > buf.length) throw new Error('обрыв DER в элементе');
    return end;
}

/** notAfter (UTC) из минимальной X.509-структуры:
 *  Certificate SEQ { tbsCertificate SEQ { [0]version? → serial → sigAlg → issuer → validity → ... }, ... }. */
function certNotAfterMs(der) {
    if (der[0] !== 0x30) throw new Error('сертификат не SEQUENCE');
    // outer: SEQ { tbsCertificate, signatureAlgorithm, signatureValue } — заходим в тело tbs.
    const tbsStart = derReadLength(der, 1)[1];
    let i = derReadLength(der, tbsStart + 1)[1];
    if (der[i] === 0xa0) i = derSkip(der, i); // [0] version (v3)
    i = derSkip(der, i); // serialNumber INTEGER
    i = derSkip(der, i); // signature AlgorithmIdentifier SEQUENCE
    i = derSkip(der, i); // issuer Name SEQUENCE
    const validityStart = derReadLength(der, i + 1)[1]; // validity SEQUENCE (i — тег, длина в i+1)
    let j = derSkip(der, validityStart); // notBefore
    const tag = der[j];
    const [timeLen, timeStart] = derReadLength(der, j + 1);
    if (timeStart + timeLen > der.length) throw new Error('обрыв DER в notAfter');
    const text = der.toString('ascii', timeStart, timeStart + timeLen);
    if (tag === 0x17) {
        const m = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
        if (!m) throw new Error('некорректный UTCTime: ' + text);
        const year = Number(m[1]) >= 50 ? 1900 + Number(m[1]) : 2000 + Number(m[1]);
        return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    }
    if (tag === 0x18) {
        const m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/);
        if (!m) throw new Error('некорректный GeneralizedTime: ' + text);
        return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    }
    throw new Error('notAfter — не time (тег ' + tag.toString(16) + ')');
}

/** Строка JSONL для alertmanager-алерта: grep по alertname работает и для firing, и для resolve. */
export function alertRecord(alert, payload) {
    const labels = alert && typeof alert.labels === 'object' && alert.labels !== null ? alert.labels : {};
    return {
        ts: new Date().toISOString(),
        source: 'alertmanager',
        status: alert && alert.status === 'resolved' ? 'resolved' : 'firing',
        alertname: labels.alertname,
        severity: labels.severity,
        service: labels.service,
        groupKey: payload && payload.groupKey,
        startsAt: alert && alert.startsAt,
        endsAt: alert && alert.endsAt,
        labels,
        annotations:
            alert && typeof alert.annotations === 'object' && alert.annotations !== null ? alert.annotations : {},
    };
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('тело запроса больше лимита'), { code: 'TOO_LARGE' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function json(res, code, value) {
    const body = JSON.stringify(value) + '\n';
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function plain(res, code, body, type = 'text/plain; charset=utf-8') {
    res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
}

function metricsText(state, certDays) {
    const certValue = Number.isFinite(certDays) ? certDays.toFixed(1) : 'NaN';
    return [
        '# HELP neurocenter_alert_receiver_up Живость host-receiver канала алертов (1 = жив).',
        '# TYPE neurocenter_alert_receiver_up gauge',
        'neurocenter_alert_receiver_up 1',
        '# HELP neurocenter_alerts_received_total Алерты alertmanager, доставленные в файл/journal.',
        '# TYPE neurocenter_alerts_received_total counter',
        `neurocenter_alerts_received_total{status="firing"} ${state.received.firing}`,
        `neurocenter_alerts_received_total{status="resolved"} ${state.received.resolved}`,
        '# HELP neurocenter_edge_cert_days_to_expiry Дней до истечения edge-сертификата (NaN = файл отсутствует).',
        '# TYPE neurocenter_edge_cert_days_to_expiry gauge',
        'neurocenter_edge_cert_days_to_expiry ' + certValue,
        '',
    ].join('\n');
}

/**
 * Поднять receiver. options: { alertsFile, certPath, port, host }.
 * Возвращает { port, close() }; закрывается idempotentно.
 */
export async function startReceiver(options = {}) {
    const alertsFile = options.alertsFile ?? DEFAULT_ALERTS_FILE;
    const certPath = options.certPath ?? DEFAULT_CERT_PATH;
    await assertAlertsFileWritable(alertsFile);
    const state = { received: { firing: 0, resolved: 0 } };
    const server = http.createServer(async (req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        try {
            if (req.method === 'GET' && url === '/ready') {
                plain(res, 200, 'ready\n');
                return;
            }
            if (req.method === 'GET' && url === '/metrics') {
                plain(res, 200, metricsText(state, daysToExpiry(certPath)), 'text/plain; version=0.0.4');
                return;
            }
            if (req.method === 'POST' && url === '/alerts') {
                let payload;
                try {
                    payload = JSON.parse(await readBody(req));
                } catch {
                    json(res, 400, { ok: false, error: 'ожидается JSON-тело webhook alertmanager' });
                    return;
                }
                if (
                    !payload ||
                    typeof payload !== 'object' ||
                    Array.isArray(payload) ||
                    !Array.isArray(payload.alerts)
                ) {
                    json(res, 400, { ok: false, error: 'поле alerts обязано быть массивом' });
                    return;
                }
                const lines = [];
                for (const alert of payload.alerts) {
                    if (!alert || typeof alert !== 'object' || Array.isArray(alert)) continue;
                    const record = alertRecord(alert, payload);
                    state.received[record.status] += 1;
                    lines.push(JSON.stringify(record) + '\n');
                    console.log(
                        '[alert-receiver] ' +
                            record.status +
                            ' ' +
                            (record.alertname ?? '?') +
                            (record.severity ? ' severity=' + record.severity : '') +
                            (record.service ? ' service=' + record.service : ''),
                    );
                }
                if (lines.length) await appendFile(alertsFile, lines.join(''), { mode: 0o600 });
                json(res, 200, { ok: true, received: lines.length });
                return;
            }
            if (url === '/alerts' || url === '/metrics' || url === '/ready') {
                json(res, 405, { ok: false, error: 'метод не поддерживается' });
                return;
            }
            json(res, 404, { ok: false, error: 'не найдено' });
        } catch (error) {
            console.error('[alert-receiver] ошибка обработки: ' + (error.message ?? error));
            if (!res.headersSent) json(res, 500, { ok: false, error: 'внутренняя ошибка' });
            else res.end();
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port ?? DEFAULT_PORT, options.host ?? DEFAULT_HOST, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const port = server.address().port;
    console.log('[alert-receiver] канал алертов слушает ' + (options.host ?? DEFAULT_HOST) + ':' + port);
    let closed = false;
    return {
        port,
        close: () => {
            if (closed) return Promise.resolve();
            closed = true;
            return new Promise((resolve) => server.close(() => resolve()));
        },
    };
}

async function main() {
    const alertsFile = process.env.ALERTS_FILE ?? DEFAULT_ALERTS_FILE;
    const certPath = process.env.CERT_PATH ?? DEFAULT_CERT_PATH;
    const port = process.env.ALERT_RECEIVER_PORT ? Number(process.env.ALERT_RECEIVER_PORT) : undefined;
    const host = process.env.ALERT_RECEIVER_HOST ?? DEFAULT_HOST;
    try {
        const receiver = await startReceiver({ alertsFile, certPath, port, host });
        const days = daysToExpiry(certPath);
        console.log(
            '[alert-receiver] ' +
                'ALERTS_FILE=' +
                alertsFile +
                ' CERT_PATH=' +
                certPath +
                ' edge-cert=' +
                (Number.isFinite(days) ? days.toFixed(1) + 'd' : 'NaN (файл отсутствует — gauge NaN)') +
                ' ' +
                host +
                ':' +
                receiver.port,
        );
    } catch (error) {
        console.error('[alert-receiver] ' + error.message);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error('[alert-receiver] ' + (error.message ?? error));
        process.exit(1);
    });
}
