/**
 * DR evidence (epic-dr 4.2, AD-OP-4): стандартизованный операторский артефакт
 * «RPO/RTO задокументированы» — один формат на три репетиции (mnt-slot /
 * s3-crosshost / upd-rehearsal), который приёмка пилота (эпик 10) сверяет
 * с policy maintenance_settings.
 *
 * Evidence НЕ измеряет сам: он читает существующие квитанции
 * (backupOperation/restoreProduction/uploadExternalBackup) + host identity
 * и smoke-результат, переданные оператором, и фиксирует разовый замер
 * репетиции в проверяемый артефакт (neurocenter-dr-evidence-v1).
 *
 * Определения совпадают с действующими (maintenance.service.ts:73,
 * maintenance-schedule.md:28): RPO = now − createdAt внешне проверенного
 * (full SHA readback) комплекта; RTO = от старта restore до healthy
 * приложений (успешный прикладной smoke).
 *
 * Никогда: RPO/RTO по upload/readback-времени или локальному Docker-restore;
 * crossHostRestoreVerified=true без target host ≠ source host (external-backups.md:62);
 * секреты/ключи в артефакте (validate-гейт).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const drEvidenceFormat = 'neurocenter-dr-evidence-v1';
export const drEvidenceScenarios = Object.freeze(['mnt-slot', 's3-crosshost', 'upd-rehearsal']);

const sha256Pattern = /^[a-f0-9]{64}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const backupIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const serviceNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** <fqdn>:<machine-id> — host identity для проверки cross-host (OQ2). */
const hostIdentityPattern =
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*:[a-f0-9]{16,64}$/i;
const smokeChecks = Object.freeze(['login', 'read', 'write', 'settingsMatched']);
const artifactKeys = Object.freeze([
    'format',
    'scenario',
    'rpoSeconds',
    'rtoSeconds',
    'dataCreatedAt',
    'verifiedAt',
    'restoreStartedAt',
    'appsHealthyAt',
    'sourceHost',
    'targetHost',
    'backupId',
    'backupSha256',
    'imageDigests',
    'storageBinding',
    'policy',
    'smoke',
    'crossHostRestoreVerified',
]);

function fail(message) {
    throw new Error(message);
}

function isIso(value) {
    if (typeof value !== 'string') return false;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}

function checkHostIdentity(value, label) {
    if (typeof value !== 'string' || !hostIdentityPattern.test(value) || value.length > 253)
        fail(label + ': нужен <fqdn>:<machine-id>');
    return value;
}

function checkStorageBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('storageBinding: нужен объект');
    const keys = ['endpoint', 'bucket', 'region', 'storageId'];
    if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('storageBinding: лишние/чужие поля');
    for (const key of keys) {
        const entry = value[key];
        if (typeof entry !== 'string' || !entry || entry.length > 253 || /[\x00-\x1f\x7f]/.test(entry))
            fail('storageBinding.' + key + ': несекретная строка обязательна');
    }
    let endpoint;
    try {
        endpoint = new URL(value.endpoint);
    } catch {
        fail('storageBinding.endpoint: нужен HTTPS URL');
    }
    if (
        endpoint.protocol !== 'https:' ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash ||
        endpoint.pathname !== '/'
    )
        fail('storageBinding.endpoint: HTTPS endpoint без учётных данных и пути');
    if (!backupIdPattern.test(value.storageId)) fail('storageBinding.storageId: нужен безопасный ID');
    return value;
}

function checkImageDigests(value, required) {
    if (value === null) {
        if (required) fail('imageDigests: нужны digests из release-манифеста');
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0)
        fail('imageDigests: нужен непустой объект service -> sha256:...');
    for (const [service, digest] of Object.entries(value)) {
        if (!serviceNamePattern.test(service)) fail('imageDigests: неверное имя сервиса ' + service);
        if (typeof digest !== 'string' || !imageDigestPattern.test(digest))
            fail('imageDigests.' + service + ': нужен digest sha256:...');
    }
    return value;
}

function checkSmoke(value, required) {
    if (value === null) {
        if (required) fail('smoke: нужен прикладной smoke-результат');
        return null;
    }
    const keys = ['login', 'read', 'write', 'settingsMatched'];
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
    )
        fail('smoke: нужны login/read/write/settingsMatched');
    for (const key of keys) if (typeof value[key] !== 'boolean') fail('smoke.' + key + ': булево');
    return value;
}

/** Квитанции: классификация по форме (uploadExternalBackup / restoreProduction / backupOperation). */
function classifyReceipt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) return null;
    if (value.verification === 'sha256-readback' && value.manifestSha256 && value.verifiedAt && value.backupId)
        return 'upload';
    if (value.restoredAt && value.durationMs !== undefined && value.projectName) return 'restore';
    if (value.sha256 && value.createdAt && value.destination) return 'backup';
    return null;
}

function checkUploadReceipt(receipt) {
    if (!backupIdPattern.test(receipt.backupId)) fail('upload: неверный backupId');
    if (typeof receipt.storageId !== 'string' || !backupIdPattern.test(receipt.storageId))
        fail('upload: неверный storageId');
    if (typeof receipt.manifestSha256 !== 'string' || !sha256Pattern.test(receipt.manifestSha256))
        fail('upload: неверный manifestSha256');
    if (!isIso(receipt.createdAt) || !isIso(receipt.verifiedAt)) fail('upload: неверные createdAt/verifiedAt');
    if (receipt.independence !== 'operator-declared') fail('upload: independence обязан быть operator-declared');
}

function checkRestoreReceipt(receipt) {
    if (!isIso(receipt.restoredAt)) fail('restore: неверный restoredAt');
    if (!isNonNegativeInteger(receipt.durationMs)) fail('restore: неверный durationMs');
    if (typeof receipt.sha256 !== 'string' || !sha256Pattern.test(receipt.sha256)) fail('restore: неверный sha256');
}

function checkBackupReceipt(receipt) {
    if (typeof receipt.sha256 !== 'string' || !sha256Pattern.test(receipt.sha256)) fail('backup: неверный sha256');
    if (!isIso(receipt.createdAt)) fail('backup: неверный createdAt');
}

function parseSmokeSpec(spec) {
    if (spec === 'ok') return { login: true, read: true, write: true, settingsMatched: true };
    // CLI-алиасы: settings -> settingsMatched.
    const aliases = Object.freeze({ login: 'login', read: 'read', write: 'write', settings: 'settingsMatched' });
    const tokens = spec.split(',').map((token) => token.trim());
    if (tokens.length === 0 || tokens.some((token) => !Object.hasOwn(aliases, token)))
        fail('--smoke: ok либо список login/read/write/settings');
    const result = Object.fromEntries(smokeChecks.map((name) => [name, false]));
    for (const token of tokens) result[aliases[token]] = true;
    return result;
}

/**
 * Сборка артефакта из квитанций + identity + policy. Формулы:
 * RPO = (restoreStartedAt | verifiedAt) − dataCreatedAt;
 * RTO = appsHealthyAt − restoreStartedAt (s3) | измеренная пауза (mnt/upd).
 */
export function recordEvidence({
    scenario,
    sourceHost,
    targetHost,
    receipts,
    smoke,
    appsHealthyAt,
    pauseSeconds,
    storageBinding,
    imageDigests,
    policy,
}) {
    if (!drEvidenceScenarios.includes(scenario)) fail('scenario: ' + drEvidenceScenarios.join(' | '));
    checkHostIdentity(sourceHost, 'sourceHost');
    checkHostIdentity(targetHost, 'targetHost');
    if (
        !policy ||
        typeof policy !== 'object' ||
        typeof policy.rpoMinutes !== 'number' ||
        !Number.isInteger(policy.rpoMinutes) ||
        policy.rpoMinutes <= 0 ||
        typeof policy.maxPauseMinutes !== 'number' ||
        !Number.isInteger(policy.maxPauseMinutes) ||
        policy.maxPauseMinutes <= 0
    )
        fail('policy: нужны rpoMinutes и maxPauseMinutes (целые, > 0)');

    const classified = new Map();
    for (const receipt of receipts) {
        const kind = classifyReceipt(receipt);
        if (!kind) fail('квитанция не распознана (backup/restore/upload)');
        if (classified.has(kind)) fail('повторная квитанция ' + kind);
        classified.set(kind, receipt);
    }
    const upload = classified.get('upload');
    if (!upload) fail('нужна квитанция uploadExternalBackup (внешне проверенный комплект — источник RPO)');
    checkUploadReceipt(upload);
    const restore = classified.get('restore');
    const backup = classified.get('backup');
    if (scenario === 's3-crosshost' && !restore) fail('s3-crosshost: нужна квитанция restoreProduction');
    if (restore) checkRestoreReceipt(restore);
    if (backup) {
        checkBackupReceipt(backup);
        if (backup.sha256 !== upload.manifestSha256 || backup.createdAt !== upload.createdAt)
            fail('backup-квитанция расходится с upload-квитанцией (SHA/createdAt)');
    }
    if (restore && restore.sha256 !== upload.manifestSha256)
        fail('restore-квитанция не совпадает с внешне проверенным комплектом (SHA)');

    const dataCreatedAt = upload.createdAt;
    const verifiedAt = upload.verifiedAt;
    let restoreStartedAt = null,
        appsHealthyIso = null,
        rtoSeconds;
    if (scenario === 's3-crosshost') {
        const restoredMs = Date.parse(restore.restoredAt);
        const startedMs = restoredMs - restore.durationMs;
        if (!Number.isFinite(startedMs)) fail('restore: restoreStartedAt не вычисляется');
        restoreStartedAt = new Date(startedMs).toISOString();
        if (typeof appsHealthyAt !== 'string' || !isIso(appsHealthyAt))
            fail('s3-crosshost: нужен --apps-healthy-at (ISO-момент healthy приложений после smoke)');
        appsHealthyIso = appsHealthyAt;
        if (Date.parse(appsHealthyIso) < startedMs) fail('appsHealthyAt обязан быть не раньше restoreStartedAt');
        rtoSeconds = Math.round((Date.parse(appsHealthyIso) - startedMs) / 1000);
    } else {
        if (typeof pauseSeconds !== 'number' || !isNonNegativeInteger(pauseSeconds))
            fail(scenario + ': нужна измеренная пауза --pause-seconds (целая, >= 0)');
        rtoSeconds = pauseSeconds;
    }

    const measurementMs = scenario === 's3-crosshost' ? Date.parse(restoreStartedAt) : Date.parse(verifiedAt);
    const dataMs = Date.parse(dataCreatedAt);
    const rpoSeconds = Math.round((measurementMs - dataMs) / 1000);
    if (rpoSeconds < 0) fail('RPO отрицателен: dataCreatedAt позже момента замера');

    const smokeValue = scenario === 'mnt-slot' ? null : checkSmoke(smoke, true);
    const binding = scenario === 'upd-rehearsal' ? null : checkStorageBinding(storageBinding);
    if (binding && binding.storageId !== upload.storageId)
        fail('storageBinding.storageId расходится с upload-квитанцией');
    const digests = checkImageDigests(imageDigests, scenario === 's3-crosshost');
    const smokePassed =
        smokeValue && smokeValue.login && smokeValue.read && smokeValue.write && smokeValue.settingsMatched;
    const crossHostRestoreVerified =
        scenario === 's3-crosshost' && sourceHost !== targetHost && restore !== undefined && smokePassed === true;

    return {
        format: drEvidenceFormat,
        scenario,
        rpoSeconds,
        rtoSeconds,
        dataCreatedAt,
        verifiedAt,
        restoreStartedAt,
        appsHealthyAt: appsHealthyIso,
        sourceHost,
        targetHost,
        backupId: upload.backupId,
        backupSha256: upload.manifestSha256,
        imageDigests: digests,
        storageBinding: binding,
        policy: { rpoMinutes: policy.rpoMinutes, maxPauseMinutes: policy.maxPauseMinutes },
        smoke: smokeValue,
        crossHostRestoreVerified,
    };
}

/** Секретоподобное значение: имя ключа или форма AWS/API-ключа (plan: no-secret gate). */
function scanForSecrets(value, keyName, problems) {
    if (typeof value === 'string') {
        const lowered = keyName.toLowerCase();
        if (/(secret|password|passwd|token|accesskey|apikey|privatekey|credential)/.test(lowered))
            problems.push('ключ с секретоподобным именем: ' + keyName);
        if (/^(AKIA|ASIA|AGPA|AIDA|AROA|ABIA|ACCA)[A-Z0-9]{8,}$/.test(value))
            problems.push('значение в форме AWS access key: ' + keyName);
        if (/sk-[a-zA-Z0-9_-]{20,}/.test(value)) problems.push('значение в форме API-ключа: ' + keyName);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => scanForSecrets(entry, keyName + '[' + index + ']', problems));
        return;
    }
    if (value && typeof value === 'object')
        for (const [name, entry] of Object.entries(value))
            scanForSecrets(entry, keyName ? keyName + '.' + name : name, problems);
}

/** Строгая схема + формулы RPO/RTO + policy + cross-host-гейт + no-secret. */
export function validateEvidence(artifact) {
    const invalid = (message) => fail('Некорректный DR-evidence: ' + message);
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) invalid('нужен объект');
    if (Object.keys(artifact).sort().join(',') !== [...artifactKeys].sort().join(',')) invalid('лишние/чужие поля');
    if (artifact.format !== drEvidenceFormat) invalid('format');
    if (!drEvidenceScenarios.includes(artifact.scenario)) invalid('scenario');
    if (!isNonNegativeInteger(artifact.rpoSeconds) || !isNonNegativeInteger(artifact.rtoSeconds))
        invalid('rpoSeconds/rtoSeconds: целые >= 0');
    if (!isIso(artifact.dataCreatedAt) || !isIso(artifact.verifiedAt)) invalid('dataCreatedAt/verifiedAt: ISO-8601');
    if (Date.parse(artifact.verifiedAt) < Date.parse(artifact.dataCreatedAt))
        invalid('verifiedAt обязан быть не раньше dataCreatedAt');
    const nullTime = (key) => artifact[key] === null;
    const isoTime = (key) => isIso(artifact[key]);
    if (
        artifact.scenario === 's3-crosshost'
            ? !isoTime('restoreStartedAt') || !isoTime('appsHealthyAt')
            : !nullTime('restoreStartedAt') || !nullTime('appsHealthyAt')
    )
        invalid('restoreStartedAt/appsHealthyAt: заполнены только для s3-crosshost');
    checkHostIdentity(artifact.sourceHost, 'sourceHost');
    checkHostIdentity(artifact.targetHost, 'targetHost');
    if (!backupIdPattern.test(artifact.backupId)) invalid('backupId');
    if (!sha256Pattern.test(artifact.backupSha256)) invalid('backupSha256');
    checkImageDigests(artifact.imageDigests, artifact.scenario === 's3-crosshost');
    if (artifact.scenario === 'upd-rehearsal') {
        if (artifact.storageBinding !== null) invalid('storageBinding: не заполняется для upd-rehearsal');
    } else if (artifact.storageBinding === null) {
        invalid('storageBinding: обязателен для ' + artifact.scenario);
    } else {
        checkStorageBinding(artifact.storageBinding);
    }
    const policy = artifact.policy;
    if (
        !policy ||
        typeof policy !== 'object' ||
        Object.keys(policy).sort().join(',') !== 'maxPauseMinutes,rpoMinutes' ||
        typeof policy.rpoMinutes !== 'number' ||
        !Number.isInteger(policy.rpoMinutes) ||
        policy.rpoMinutes <= 0 ||
        typeof policy.maxPauseMinutes !== 'number' ||
        !Number.isInteger(policy.maxPauseMinutes) ||
        policy.maxPauseMinutes <= 0
    )
        invalid('policy: rpoMinutes/maxPauseMinutes (целые, > 0)');
    checkSmoke(artifact.smoke, artifact.scenario !== 'mnt-slot');
    if (artifact.scenario === 'mnt-slot' && artifact.smoke !== null) invalid('smoke: не заполняется для mnt-slot');
    if (typeof artifact.crossHostRestoreVerified !== 'boolean') invalid('crossHostRestoreVerified: булево');

    // Формулы: RPO = (restoreStartedAt | verifiedAt) − dataCreatedAt; RTO — по сценарию.
    const measurementMs =
        artifact.scenario === 's3-crosshost' ? Date.parse(artifact.restoreStartedAt) : Date.parse(artifact.verifiedAt);
    const expectedRpo = Math.round((measurementMs - Date.parse(artifact.dataCreatedAt)) / 1000);
    if (artifact.rpoSeconds !== expectedRpo)
        invalid('RPO не совпадает с формулой: записано ' + artifact.rpoSeconds + ', по квитанциям ' + expectedRpo);
    if (artifact.rpoSeconds > artifact.policy.rpoMinutes * 60)
        invalid(
            'RPO ' +
                artifact.rpoSeconds +
                's превышает policy.rpoMinutes=' +
                artifact.policy.rpoMinutes +
                ' (' +
                artifact.policy.rpoMinutes * 60 +
                's)',
        );
    if (artifact.scenario === 's3-crosshost') {
        if (Date.parse(artifact.appsHealthyAt) < Date.parse(artifact.restoreStartedAt))
            invalid('appsHealthyAt обязан быть не раньше restoreStartedAt');
        const expectedRto = Math.round(
            (Date.parse(artifact.appsHealthyAt) - Date.parse(artifact.restoreStartedAt)) / 1000,
        );
        if (artifact.rtoSeconds !== expectedRto)
            invalid('RTO не совпадает с формулой: записано ' + artifact.rtoSeconds + ', по квитанциям ' + expectedRto);
    } else if (artifact.scenario === 'mnt-slot') {
        if (artifact.rtoSeconds > artifact.policy.maxPauseMinutes * 60)
            invalid(
                'пауза ' +
                    artifact.rtoSeconds +
                    's превышает policy.maxPauseMinutes=' +
                    artifact.policy.maxPauseMinutes,
            );
    }

    // Cross-host-гейт: true только при target ≠ source + restore + полный smoke.
    if (artifact.crossHostRestoreVerified) {
        if (
            artifact.scenario !== 's3-crosshost' ||
            artifact.sourceHost === artifact.targetHost ||
            !artifact.smoke ||
            !smokeChecks.every((name) => artifact.smoke[name])
        )
            invalid(
                'crossHostRestoreVerified=true требует s3-crosshost, target host ≠ source host и полный smoke (external-backups.md:62)',
            );
    }

    const problems = [];
    scanForSecrets(artifact, '', problems);
    if (problems.length) invalid('секретоподобные значения: ' + problems.join('; '));
    return artifact;
}

/** Человекочитаемый отчёт (docs: «RPO/RTO задокументированы»). */
export function renderEvidenceReport(artifact) {
    const evidence = validateEvidence(artifact);
    const seconds = (value) => value + ' s (' + Math.floor(value / 60) + ' мин ' + (value % 60) + ' с)';
    const lines = [
        '# DR evidence — ' + evidence.scenario,
        '',
        'Формат: `' + evidence.format + '` (machine-verifiable: dr-evidence.json, этот MD — зеркало).',
        '',
        '## RPO/RTO',
        '',
        '- RPO: **' + seconds(evidence.rpoSeconds) + '** (политика: <= ' + evidence.policy.rpoMinutes + ' мин)',
        '- RTO: **' +
            seconds(evidence.rtoSeconds) +
            '**' +
            (evidence.scenario === 'mnt-slot' ? ' (измеренная пауза)' : ''),
        '- dataCreatedAt: ' + evidence.dataCreatedAt,
        '- verifiedAt (SHA readback): ' + evidence.verifiedAt,
    ];
    if (evidence.restoreStartedAt) {
        lines.push('- restoreStartedAt: ' + evidence.restoreStartedAt);
        lines.push('- appsHealthyAt: ' + evidence.appsHealthyAt);
    }
    lines.push(
        '',
        '## Host identity',
        '',
        '- source: `' + evidence.sourceHost + '`',
        '- target: `' + evidence.targetHost + '`',
        '- crossHostRestoreVerified: **' + String(evidence.crossHostRestoreVerified) + '**',
        '',
        '## Backup',
        '',
        '- backupId: `' + evidence.backupId + '`',
        '- SHA256 описи: `' + evidence.backupSha256 + '`',
    );
    if (evidence.imageDigests) {
        lines.push('', '## Image digests', '');
        for (const [service, digest] of Object.entries(evidence.imageDigests))
            lines.push('- ' + service + ': `' + digest + '`');
    }
    if (evidence.storageBinding) {
        const binding = evidence.storageBinding;
        lines.push(
            '',
            '## Storage binding (без ключей)',
            '',
            '- endpoint: ' + binding.endpoint,
            '- bucket: ' + binding.bucket,
            '- region: ' + binding.region,
            '- storageId: `' + binding.storageId + '`',
        );
    }
    if (evidence.smoke) {
        lines.push(
            '',
            '## Прикладной smoke',
            '',
            '- login: ' + evidence.smoke.login,
            '- read: ' + evidence.smoke.read,
            '- write: ' + evidence.smoke.write,
            '- settingsMatched: ' + evidence.smoke.settingsMatched,
        );
    }
    lines.push(
        '',
        '## Политика (maintenance_settings)',
        '',
        '- rpoMinutes: ' + evidence.policy.rpoMinutes,
        '- maxPauseMinutes: ' + evidence.policy.maxPauseMinutes,
        '',
    );
    return lines.join('\n');
}

/** Атомарная запись 0600 в закрытый каталог (паттерн writeReleaseManifest). */
export async function writeEvidence(filename, artifact) {
    const value = JSON.stringify(validateEvidence(artifact), null, 2) + '\n';
    const directory = path.dirname(filename);
    for (const level of [path.dirname(directory), directory]) {
        let info;
        try {
            info = await lstat(level);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await mkdir(level, { recursive: true, mode: 0o700 });
            info = await lstat(level);
        }
        if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
            throw new Error('Каталог DR-evidence должен быть закрытым обычным каталогом');
    }
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, value, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

function readJson(filename) {
    return JSON.parse(readFileSync(filename, 'utf8'));
}

async function main() {
    process.umask(0o077);
    const args = process.argv.slice(2);
    const mode = args.shift();
    const values = {};
    const lists = { from: [] };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        const next = args[i + 1];
        if (!next || next.startsWith('--')) throw new Error('Незаполненный параметр ' + flag);
        i++;
        if (flag === '--from') lists.from.push(next);
        else if (Object.hasOwn(values, flag)) throw new Error('Повторный параметр ' + flag);
        else values[flag] = next;
    }
    const need = (flag) => {
        const value = values[flag];
        if (value === undefined) throw new Error('Нужен ' + flag);
        return value;
    };
    if (mode === 'record') {
        const storageBinding = values['--storage-endpoint']
            ? {
                  endpoint: values['--storage-endpoint'],
                  bucket: values['--storage-bucket'],
                  region: values['--storage-region'],
                  storageId: values['--storage-id'],
              }
            : null;
        let imageDigests = null;
        if (values['--manifest']) {
            const manifest = readJson(values['--manifest']);
            imageDigests = { ...(manifest.images || {}), postgres: manifest.postgresImage };
        }
        const evidence = recordEvidence({
            scenario: need('--scenario'),
            sourceHost: need('--source-host'),
            targetHost: need('--target-host'),
            receipts: lists.from.map(readJson),
            smoke: values['--smoke'] ? parseSmokeSpec(values['--smoke']) : null,
            appsHealthyAt: values['--apps-healthy-at'],
            pauseSeconds: values['--pause-seconds'] === undefined ? undefined : Number(values['--pause-seconds']),
            storageBinding,
            imageDigests,
            policy: {
                rpoMinutes: Number(need('--rpo-minutes')),
                maxPauseMinutes: Number(need('--max-pause-minutes')),
            },
        });
        const out = path.resolve(need('--out'));
        await writeEvidence(out, evidence);
        console.log(out);
    } else if (mode === 'validate') {
        validateEvidence(readJson(path.resolve(need('--evidence'))));
        console.log('DR-evidence валиден');
    } else if (mode === 'report') {
        const evidence = path.resolve(need('--evidence'));
        const out = path.resolve(values['--out'] || evidence.replace(/\.json$/, '.md'));
        await writeFile(out, renderEvidenceReport(readJson(evidence)), { mode: 0o600 });
        console.log(out);
    } else {
        throw new Error(
            'Команды: record --scenario <mnt-slot|s3-crosshost|upd-rehearsal> --from <квитанция.json> [...] --source-host <fqdn:machine-id> --target-host <fqdn:machine-id> [--smoke ok] [--apps-healthy-at <ISO>|--pause-seconds <N>] [--manifest <release-manifest.json>] [--storage-endpoint <u> --storage-bucket <b> --storage-region <r> --storage-id <i>] --rpo-minutes <N> --max-pause-minutes <N> --out <file> | validate --evidence <file> | report --evidence <file> [--out <md>]',
        );
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
