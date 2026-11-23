import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { startReceiver, daysToExpiry } from '../production/alert-receiver.mjs';

/**
 * AD-O6 (ep6 entry 13): host-receiver канала алертов — тесты POST /alerts (JSONL),
 * /metrics (receiver_up, счётчики, days-to-expiry), /ready, 405/400/404, fail-fast
 * на не-writable каталог. Зависимостей нет (node:test + fetch).
 *
 * Fixture-сертификаты: DER X.509 собирается программно (структурно корректен до
 * validity), чтобы days-to-expiry был детерминирован без openssl; отдельный тест
 * сверяется с реальным self-signed (openssl), если он есть на хосте.
 */

const derTag = (tag, body) => {
    let len;
    if (body.length < 0x80) len = Buffer.from([body.length]);
    else if (body.length < 0x100) len = Buffer.from([0x81, body.length]);
    else len = Buffer.from([0x82, (body.length >> 8) & 0xff, body.length & 0xff]);
    return Buffer.concat([Buffer.from([tag]), len, body]);
};
const derInt = (n) => derTag(0x02, Buffer.from([n]));
const derNull = () => derTag(0x05, Buffer.alloc(0));
const derOid = (bytes) => derTag(0x06, Buffer.from(bytes));
const derUtf8 = (s) => derTag(0x0c, Buffer.from(s, 'utf8'));
const derUtc = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    const text =
        p(d.getUTCFullYear() % 100) +
        p(d.getUTCMonth() + 1) +
        p(d.getUTCDate()) +
        p(d.getUTCHours()) +
        p(d.getUTCMinutes()) +
        p(d.getUTCSeconds()) +
        'Z';
    return derTag(0x17, Buffer.from(text, 'ascii'));
};

/** Минимальный структурно корректный X.509 (v3) с заданным notAfter. */
function buildCertPem(notAfterMs) {
    const sha256WithRsa = derTag(
        0x30,
        Buffer.concat([derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09]), derNull()]),
    );
    const rdn = derTag(0x30, Buffer.concat([derOid([0x55, 0x04, 0x03]), derUtf8('CN=neurocenter-test')]));
    const name = derTag(0x30, derTag(0x31, rdn));
    const validity = derTag(0x30, Buffer.concat([derUtc(Date.now()), derUtc(notAfterMs)]));
    const spki = derTag(
        0x30,
        Buffer.concat([
            derTag(0x30, Buffer.concat([derOid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]), derNull()])),
            derNull(),
        ]),
    );
    const tbs = derTag(
        0x30,
        Buffer.concat([derTag(0xa0, derInt(2)), derInt(1), sha256WithRsa, name, validity, name, spki]),
    );
    const sig = derTag(0x03, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32)]));
    const der = derTag(0x30, Buffer.concat([tbs, sha256WithRsa, sig]));
    const b64 = der
        .toString('base64')
        .match(/.{1,64}/g)
        .join('\n');
    return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

const DAY = 86400000;

const makeAlert = (status = 'firing', overrides = {}) => ({
    status,
    labels: {
        alertname: 'NeurocenterDiskSpaceLow',
        severity: 'critical',
        service: 'capacity-collector',
        job: 'neurocenter',
        instance: 'node_exporter:9100',
    },
    annotations: { summary: 'Свободное место физического тома ниже резерва или 15 процентов' },
    startsAt: '2026-11-23T10:00:00.000Z',
    endsAt: status === 'resolved' ? '2026-11-23T10:05:00.000Z' : '0001-01-01T00:00:00.000Z',
    generatorURL: 'http://prometheus/alerts',
    fingerprint: 'fp-1',
    ...overrides,
});
const alertPayload = (status, alerts) => ({
    version: '4',
    groupKey: 'group:1',
    status,
    receiver: 'neurocenter-file-sink',
    commonLabels: { alertname: 'NeurocenterDiskSpaceLow' },
    alerts,
});

const alertsPath = (dir) => path.join(dir, 'alerts.jsonl');
const readJsonLines = async (file) =>
    (await fs.readFile(file, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
const metrics = async (base) => (await fetch(base + '/metrics')).text();

test('daysToExpiry: fixture-сертификат 10 дней и 100 дней; отсутствие файла → NaN', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver cert '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const soon = path.join(dir, 'soon.pem');
    const ok = path.join(dir, 'ok.pem');
    await fs.writeFile(soon, buildCertPem(Date.now() + 10 * DAY));
    await fs.writeFile(ok, buildCertPem(Date.now() + 100 * DAY));
    const daysSoon = daysToExpiry(soon);
    const daysOk = daysToExpiry(ok);
    assert.ok(Math.abs(daysSoon - 10) < 0.05, `ожидалось ~10, got ${daysSoon}`);
    assert.ok(Math.abs(daysOk - 100) < 0.05, `ожидалось ~100, got ${daysOk}`);
    assert.ok(Number.isNaN(daysToExpiry(path.join(dir, 'absent.pem'))));
});

test('POST /alerts firing → JSONL-строка: формат, права файла 0600 и каталога 0700', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = alertsPath(dir);
    const receiver = await startReceiver({
        alertsFile: file,
        certPath: path.join(dir, 'absent.pem'),
        port: 0,
        host: '127.0.0.1',
    });
    try {
        const res = await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify(alertPayload('firing', [makeAlert('firing')])),
            headers: { 'content-type': 'application/json' },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, received: 1 });
        const [line] = await readJsonLines(file);
        assert.equal(line.source, 'alertmanager');
        assert.equal(line.status, 'firing');
        assert.equal(line.alertname, 'NeurocenterDiskSpaceLow');
        assert.equal(line.severity, 'critical');
        assert.equal(line.service, 'capacity-collector');
        assert.equal(line.groupKey, 'group:1');
        assert.equal(line.annotations.summary, 'Свободное место физического тома ниже резерва или 15 процентов');
        assert.equal(line.labels.instance, 'node_exporter:9100');
        assert.ok(!Number.isNaN(Date.parse(line.ts)), 'ts — валидный ISO-время');
        const fileStat = await fs.stat(file);
        assert.equal(fileStat.mode & 0o777, 0o600, 'файл 0600');
        const dirStat = await fs.stat(dir);
        assert.equal(dirStat.mode & 0o777, 0o700, 'каталог 0700');
    } finally {
        await receiver.close();
    }
});

test('POST /alerts resolved → resolve-строка (status resolved) — снятие алерта доставляется', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = alertsPath(dir);
    const receiver = await startReceiver({ alertsFile: file, port: 0, host: '127.0.0.1' });
    try {
        const res = await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify(alertPayload('resolved', [makeAlert('resolved')])),
        });
        assert.equal(res.status, 200);
        const [line] = await readJsonLines(file);
        assert.equal(line.status, 'resolved');
        assert.equal(line.alertname, 'NeurocenterDiskSpaceLow');
        assert.ok(!Number.isNaN(Date.parse(line.ts)));
    } finally {
        await receiver.close();
    }
});

test('несколько алертов в одном payload → N строк; мусор в массиве не пишется', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = alertsPath(dir);
    const receiver = await startReceiver({ alertsFile: file, port: 0, host: '127.0.0.1' });
    try {
        const res = await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify(
                alertPayload('firing', [
                    makeAlert('firing'),
                    'garbage',
                    null,
                    makeAlert('firing', {
                        labels: { ...makeAlert().labels, alertname: 'NeurocenterStackDown', severity: 'critical' },
                    }),
                ]),
            ),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true, received: 2 });
        const lines = await readJsonLines(file);
        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.alertname).sort(), [
            'NeurocenterDiskSpaceLow',
            'NeurocenterStackDown',
        ]);
    } finally {
        await receiver.close();
    }
});

test('GET /metrics: receiver_up=1, счётчики firing/resolved, days-to-expiry из fixture-сертификата', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = alertsPath(dir);
    const cert = path.join(dir, 'edge.pem');
    await fs.writeFile(cert, buildCertPem(Date.now() + 10 * DAY));
    const receiver = await startReceiver({ alertsFile: file, certPath: cert, port: 0, host: '127.0.0.1' });
    try {
        await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify(alertPayload('firing', [makeAlert('firing'), makeAlert('firing')])),
        });
        await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify(alertPayload('resolved', [makeAlert('resolved')])),
        });
        const text = await metrics(`http://127.0.0.1:${receiver.port}`);
        assert.match(text, /^# TYPE neurocenter_alert_receiver_up gauge$/m);
        assert.match(text, /^neurocenter_alert_receiver_up 1$/m);
        assert.match(text, /^neurocenter_alerts_received_total\{status="firing"\} 2$/m);
        assert.match(text, /^neurocenter_alerts_received_total\{status="resolved"\} 1$/m);
        const m = text.match(/^neurocenter_edge_cert_days_to_expiry (\S+)$/m);
        assert.ok(m, 'gauge days-to-expiry на месте');
        const days = Number(m[1]);
        assert.ok(days > 9.5 && days < 10.5, `ожидалось ~10, got ${days}`);
    } finally {
        await receiver.close();
    }
});

test('GET /metrics: сертификат отсутствует → gauge NaN, receiver_up остаётся 1', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const receiver = await startReceiver({
        alertsFile: alertsPath(dir),
        certPath: path.join(dir, 'absent.pem'),
        port: 0,
        host: '127.0.0.1',
    });
    try {
        const text = await metrics(`http://127.0.0.1:${receiver.port}`);
        assert.match(text, /^neurocenter_alert_receiver_up 1$/m);
        assert.match(text, /^neurocenter_edge_cert_days_to_expiry NaN$/m);
    } finally {
        await receiver.close();
    }
});

test('GET /ready → 200', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const receiver = await startReceiver({ alertsFile: alertsPath(dir), port: 0, host: '127.0.0.1' });
    try {
        const res = await fetch(`http://127.0.0.1:${receiver.port}/ready`);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /ready/);
    } finally {
        await receiver.close();
    }
});

test('405 на неверный метод известных путей, 404 на чужой путь', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const receiver = await startReceiver({ alertsFile: alertsPath(dir), port: 0, host: '127.0.0.1' });
    try {
        assert.equal((await fetch(`http://127.0.0.1:${receiver.port}/alerts`)).status, 405);
        assert.equal((await fetch(`http://127.0.0.1:${receiver.port}/metrics`, { method: 'POST' })).status, 405);
        assert.equal((await fetch(`http://127.0.0.1:${receiver.port}/nope`)).status, 404);
    } finally {
        await receiver.close();
    }
});

test('400: не-JSON тело и alerts не массив', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const receiver = await startReceiver({ alertsFile: alertsPath(dir), port: 0, host: '127.0.0.1' });
    try {
        const bad = await fetch(`http://127.0.0.1:${receiver.port}/alerts`, { method: 'POST', body: 'not-json' });
        assert.equal(bad.status, 400);
        const noArray = await fetch(`http://127.0.0.1:${receiver.port}/alerts`, {
            method: 'POST',
            body: JSON.stringify({ alerts: 'не массив' }),
        });
        assert.equal(noArray.status, 400);
        // Файл не создан: ни одной строки не записано.
        await assert.rejects(fs.stat(alertsPath(dir)));
    } finally {
        await receiver.close();
    }
});

test('fail-fast: не-writable каталог — startReceiver отклоняется с путём в ошибке', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    let target;
    if (process.geteuid && process.geteuid() === 0 && process.platform === 'linux') {
        // root не падает на 0500-каталоге: read-only файловая система как гарантированный отказ.
        target = '/sys/fs/neurocenter-alert-receiver-probe.jsonl';
    } else {
        const locked = path.join(dir, 'locked');
        await fs.mkdir(locked, { mode: 0o500 });
        target = path.join(locked, 'sub', 'alerts.jsonl');
    }
    await assert.rejects(startReceiver({ alertsFile: target, port: 0, host: '127.0.0.1' }), (error) => {
        assert.match(error.message, /Канал алертов недоступен/);
        assert.ok(error.message.includes(target), 'путь в сообщении об ошибке: ' + error.message);
        return true;
    });
});

test('openssl-сверка: реальный self-signed сертификат парсится (skip, если openssl нет)', async (t) => {
    const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
        t.skip('openssl отсутствует на хосте');
        return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc alert-receiver openssl '));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const cert = path.join(dir, 'edge.pem');
    const result = spawnSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            path.join(dir, 'key.pem'),
            '-out',
            cert,
            '-days',
            '10',
            '-subj',
            '/CN=neurocenter-test',
        ],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const days = daysToExpiry(cert);
    assert.ok(days > 8.5 && days < 11.5, `ожидалось ~10, got ${days}`);
});
