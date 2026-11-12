/**
 * DR evidence (epic-dr 4.2, AD-OP-4): офлайн unit-тесты record/validate/report
 * на фиктивных квитанциях (без docker/S3) + CLI-дым.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    drEvidenceFormat,
    recordEvidence,
    renderEvidenceReport,
    validateEvidence,
    writeEvidence,
} from '../production/dr-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SHA = 'a'.repeat(64);
const DIGEST = 'sha256:' + 'b'.repeat(64);

const uploadReceipt = {
    ok: true,
    backupId: 'backup-2026-11-12-01',
    storageId: 's3-target-1',
    manifestSha256: SHA,
    createdAt: '2026-11-12T08:00:00.000Z',
    verifiedAt: '2026-11-12T08:05:00.000Z',
    files: 3,
    bytes: 1234,
    transportFormat: 'neurocenter-external-v1',
    verification: 'sha256-readback',
    independence: 'operator-declared',
    crossHostRestoreVerified: false,
};
const restoreReceipt = {
    ok: true,
    projectName: 'nc-restore-target',
    sha256: SHA,
    restoredAt: '2026-11-12T09:30:00.000Z',
    databases: 3,
    durationMs: 1800000,
    applicationsStarted: false,
};
const backupReceipt = {
    ok: true,
    destination: '/var/neurocenter/backups/slot-1',
    sha256: SHA,
    createdAt: '2026-11-12T08:00:00.000Z',
    databases: 3,
    files: 3,
    bytes: 1234,
};
const sourceHost = 'src-host.cbr.ru:' + 'c'.repeat(32);
const targetHost = 'dst-host.cbr.ru:' + 'd'.repeat(32);
const storageBinding = {
    endpoint: 'https://s3.dr.example.cbr.ru',
    bucket: 'dr-backups',
    region: 'us-east-1',
    storageId: 's3-target-1',
};
const policy = { rpoMinutes: 60, maxPauseMinutes: 10 };
const smokeAll = { login: true, read: true, write: true, settingsMatched: true };
const imageDigests = { 'catalog-service': DIGEST, postgres: DIGEST };

function s3Inputs(overrides = {}) {
    return {
        scenario: 's3-crosshost',
        sourceHost,
        targetHost,
        receipts: [uploadReceipt, restoreReceipt, backupReceipt],
        smoke: smokeAll,
        appsHealthyAt: '2026-11-12T09:35:00.000Z',
        storageBinding,
        imageDigests,
        policy,
        ...overrides,
    };
}

test('record s3-crosshost: квитанции + identity + smoke -> валидный артефакт с RPO/RTO и cross-host=true', () => {
    const evidence = recordEvidence(s3Inputs());
    assert.equal(evidence.format, drEvidenceFormat);
    // RPO = restoreStartedAt (09:30 − 30 мин = 09:00) − dataCreatedAt (08:00) = 3600 s.
    assert.equal(evidence.rpoSeconds, 3600);
    // RTO = appsHealthyAt (09:35) − restoreStartedAt (09:00) = 2100 s.
    assert.equal(evidence.rtoSeconds, 2100);
    assert.equal(evidence.restoreStartedAt, '2026-11-12T09:00:00.000Z');
    assert.equal(evidence.dataCreatedAt, uploadReceipt.createdAt);
    assert.equal(evidence.verifiedAt, uploadReceipt.verifiedAt);
    assert.equal(evidence.appsHealthyAt, '2026-11-12T09:35:00.000Z');
    assert.equal(evidence.backupId, uploadReceipt.backupId);
    assert.equal(evidence.backupSha256, SHA);
    assert.deepEqual(evidence.storageBinding, storageBinding);
    assert.equal(evidence.crossHostRestoreVerified, true);
    validateEvidence(evidence);
});

test('record s3-crosshost: target == source -> crossHostRestoreVerified=false (external-backups.md:62)', () => {
    const evidence = recordEvidence(s3Inputs({ targetHost: sourceHost }));
    assert.equal(evidence.crossHostRestoreVerified, false);
    validateEvidence(evidence);
});

test('record s3-crosshost: неполный smoke -> crossHostRestoreVerified=false', () => {
    const evidence = recordEvidence(
        s3Inputs({ smoke: { login: true, read: true, write: true, settingsMatched: false } }),
    );
    assert.equal(evidence.crossHostRestoreVerified, false);
    validateEvidence(evidence);
});

test('record s3-crosshost: без restore-квитанции -> фэйл', () => {
    assert.throws(() => recordEvidence(s3Inputs({ receipts: [uploadReceipt, backupReceipt] })), /restoreProduction/);
});

test('record s3-crosshost: restore-SHA расходится с upload -> фэйл', () => {
    assert.throws(
        () => recordEvidence(s3Inputs({ receipts: [uploadReceipt, { ...restoreReceipt, sha256: 'f'.repeat(64) }] })),
        /SHA/,
    );
});

test('record mnt-slot: upload + пауза -> валидный артефакт, RTO = пауза, smoke/storage по сценарию', () => {
    const evidence = recordEvidence({
        scenario: 'mnt-slot',
        sourceHost,
        targetHost: sourceHost,
        receipts: [uploadReceipt],
        smoke: null,
        pauseSeconds: 120,
        storageBinding,
        imageDigests: null,
        policy,
    });
    // RPO = verifiedAt (08:05) − dataCreatedAt (08:00) = 300 s.
    assert.equal(evidence.rpoSeconds, 300);
    assert.equal(evidence.rtoSeconds, 120);
    assert.equal(evidence.restoreStartedAt, null);
    assert.equal(evidence.appsHealthyAt, null);
    assert.equal(evidence.smoke, null);
    assert.equal(evidence.crossHostRestoreVerified, false);
    validateEvidence(evidence);
});

test('record mnt-slot: без паузы -> фэйл', () => {
    assert.throws(
        () =>
            recordEvidence({
                scenario: 'mnt-slot',
                sourceHost,
                targetHost: sourceHost,
                receipts: [uploadReceipt],
                smoke: null,
                pauseSeconds: undefined,
                storageBinding,
                imageDigests: null,
                policy,
            }),
        /пауза/,
    );
});

test('record upd-rehearsal: upload + пауза + smoke, storageBinding=null -> валидный артефакт', () => {
    const evidence = recordEvidence({
        scenario: 'upd-rehearsal',
        sourceHost,
        targetHost: sourceHost,
        receipts: [uploadReceipt],
        smoke: { login: true, read: true, write: true, settingsMatched: false },
        pauseSeconds: 60,
        storageBinding: null,
        imageDigests,
        policy,
    });
    assert.equal(evidence.rpoSeconds, 300);
    assert.equal(evidence.rtoSeconds, 60);
    assert.equal(evidence.storageBinding, null);
    assert.equal(evidence.crossHostRestoreVerified, false);
    validateEvidence(evidence);
});

test('record: storageBinding.storageId расходится с upload-квитанцией -> фэйл', () => {
    assert.throws(
        () => recordEvidence(s3Inputs({ storageBinding: { ...storageBinding, storageId: 'other-storage' } })),
        /storageId/,
    );
});

test('record: без upload-квитанции -> фэйл (внешне проверенный комплект — единственный источник RPO)', () => {
    assert.throws(
        () =>
            recordEvidence({
                scenario: 'mnt-slot',
                sourceHost,
                targetHost: sourceHost,
                receipts: [backupReceipt],
                smoke: null,
                pauseSeconds: 60,
                storageBinding,
                imageDigests: null,
                policy,
            }),
        /uploadExternalBackup/,
    );
});

test('validate: RPO > policy.rpoMinutes -> фэйл с указанием RPO и policy', () => {
    const evidence = recordEvidence(s3Inputs());
    assert.throws(
        () => validateEvidence({ ...evidence, policy: { rpoMinutes: 1, maxPauseMinutes: 10 } }),
        /RPO 3600s превышает policy\.rpoMinutes=1/,
    );
});

test('validate: mnt-slot пауза > policy.maxPauseMinutes -> фэйл', () => {
    const evidence = recordEvidence({
        scenario: 'mnt-slot',
        sourceHost,
        targetHost: sourceHost,
        receipts: [uploadReceipt],
        smoke: null,
        pauseSeconds: 900,
        storageBinding,
        imageDigests: null,
        policy,
    });
    // record не проверяет policy (это задача validate): пауза сохранена, validate ловит.
    assert.equal(evidence.rtoSeconds, 900);
    assert.throws(() => validateEvidence(evidence), /максимальной|maxPauseMinutes/);
});

test('validate: crossHostRestoreVerified=true при target == source -> фэйл', () => {
    const evidence = recordEvidence(s3Inputs({ targetHost: sourceHost }));
    assert.throws(() => validateEvidence({ ...evidence, crossHostRestoreVerified: true }), /target host ≠ source host/);
});

test('validate: crossHostRestoreVerified=true для mnt-slot -> фэйл', () => {
    const evidence = recordEvidence({
        scenario: 'mnt-slot',
        sourceHost,
        targetHost,
        receipts: [uploadReceipt],
        smoke: null,
        pauseSeconds: 60,
        storageBinding,
        imageDigests: null,
        policy,
    });
    assert.throws(() => validateEvidence({ ...evidence, crossHostRestoreVerified: true }), /s3-crosshost/);
});

test('validate: секретоподобные значения (sk-ключ, AWS access key) -> фэйл', () => {
    const evidence = recordEvidence(s3Inputs());
    assert.throws(
        () => validateEvidence({ ...evidence, storageBinding: { ...storageBinding, bucket: 'sk-' + 'x'.repeat(24) } }),
        /API-ключа|секретоподоб/,
    );
    assert.throws(
        () =>
            validateEvidence({
                ...evidence,
                storageBinding: { ...storageBinding, storageId: 'AKIA' + 'Q'.repeat(16) },
            }),
        /AWS access key|секретоподоб/,
    );
});

test('validate: чужие/лишние поля -> фэйл; некорректный format -> фэйл', () => {
    const evidence = recordEvidence(s3Inputs());
    assert.throws(() => validateEvidence({ ...evidence, extra: 1 }), /лишние|чужие/);
    assert.throws(() => validateEvidence({ ...evidence, format: 'neurocenter-dr-evidence-v2' }), /format/);
});

test('validate: RPO-формула нарушена (rpoSeconds врублен) -> фэйл', () => {
    const evidence = recordEvidence(s3Inputs());
    assert.throws(() => validateEvidence({ ...evidence, rpoSeconds: 3599 }), /формулой/);
});

test('report: MD содержит RPO/RTO, host identity, backup ID/SHA, digests, smoke', () => {
    const evidence = recordEvidence(s3Inputs());
    const report = renderEvidenceReport(evidence);
    assert.match(report, /## RPO\/RTO/);
    assert.match(report, /3600 s/);
    assert.match(report, /2100 s/);
    assert.match(report, new RegExp(sourceHost.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&')));
    assert.match(report, /dst-host\.cbr\.ru/);
    assert.match(report, /backup-2026-11-12-01/);
    assert.match(report, new RegExp(SHA.slice(0, 16)));
    assert.match(report, new RegExp(DIGEST.slice(0, 24)));
    assert.match(report, /crossHostRestoreVerified: \*\*true\*\*/);
    assert.match(report, /s3\.dr\.example\.cbr\.ru/);
});

test('writeEvidence: 0600 в закрытом каталоге, переписывание, открытый каталог -> фэйл', async (t) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc dr evidence '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const closed = path.join(directory, 'closed');
    await fs.mkdir(closed, { recursive: true, mode: 0o700 });
    const evidence = recordEvidence(s3Inputs());
    const filename = path.join(closed, 'dr-evidence.json');
    await writeEvidence(filename, evidence);
    const info = await fs.lstat(filename);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), evidence);
    // Повторная запись (rename поверх) проходит.
    await writeEvidence(filename, evidence);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), evidence);
    // Некорректный артефакт не записывается.
    await assert.rejects(writeEvidence(filename, { ...evidence, rpoSeconds: 1 }), /DR-evidence/);
    // Открытый каталог (0755) отклоняется.
    const openDir = path.join(directory, 'open-755');
    await fs.mkdir(openDir, { recursive: true, mode: 0o755 });
    await assert.rejects(writeEvidence(path.join(openDir, 'evidence.json'), evidence), /закрытым/);
});

test('CLI: record -> validate -> report офлайн (фиктивные квитанции), ошибки -> exit 1', async (t) => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc dr evidence cli '));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const closed = path.join(directory, 'closed');
    await fs.mkdir(closed, { recursive: true, mode: 0o700 });
    const write = async (name, value) => fs.writeFile(path.join(closed, name), JSON.stringify(value, null, 2));
    await write('upload.json', uploadReceipt);
    await write('restore.json', restoreReceipt);
    await write('backup.json', backupReceipt);
    await write('manifest.json', { images: { 'catalog-service': DIGEST }, postgresImage: DIGEST });
    const script = path.join(root, 'scripts/production/dr-evidence.mjs');
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root });
    const evidencePath = path.join(closed, 'dr-evidence.json');
    const record = run([
        'record',
        '--scenario',
        's3-crosshost',
        '--from',
        path.join(closed, 'upload.json'),
        '--from',
        path.join(closed, 'restore.json'),
        '--from',
        path.join(closed, 'backup.json'),
        '--source-host',
        sourceHost,
        '--target-host',
        targetHost,
        '--smoke',
        'ok',
        '--apps-healthy-at',
        '2026-11-12T09:35:00.000Z',
        '--storage-endpoint',
        'https://s3.dr.example.cbr.ru',
        '--storage-bucket',
        'dr-backups',
        '--storage-region',
        'us-east-1',
        '--storage-id',
        's3-target-1',
        '--manifest',
        path.join(closed, 'manifest.json'),
        '--rpo-minutes',
        '60',
        '--max-pause-minutes',
        '10',
        '--out',
        evidencePath,
    ]);
    assert.equal(record.status, 0, record.stderr);
    const validate = run(['validate', '--evidence', evidencePath]);
    assert.equal(validate.status, 0, validate.stderr);
    assert.match(validate.stdout, /валиден/);
    const report = run(['report', '--evidence', evidencePath]);
    assert.equal(report.status, 0, report.stderr);
    const md = await fs.readFile(evidencePath.replace(/\.json$/, '.md'), 'utf8');
    assert.match(md, /## RPO\/RTO/);
    assert.match(md, /3600 s/);
    // Ошибки: незаполненный параметр и невалидный артефакт -> exit 1.
    const missing = run(['record', '--scenario']);
    assert.equal(missing.status, 1);
    const bad = path.join(closed, 'bad.json');
    const evidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
    await write('bad.json', { ...evidence, rpoSeconds: 1 });
    const invalid = run(['validate', '--evidence', bad]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /RPO/);
});
