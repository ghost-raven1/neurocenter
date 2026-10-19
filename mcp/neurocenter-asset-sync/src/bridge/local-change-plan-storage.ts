import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, stateDir } from './state.js';
import { canonicalV4 } from './package.js';
import { readBoundedUtf8, readBoundedSnapshot } from './read-bounded.js';
import { recoveryDirectory, withRecoveryBudget } from './installation-space.js';
import { atomicText } from './atomic-file.js';
import { installationReadLimit } from './installation-limits.js';
import { validateChanges, type FileChange } from './installation-journal.js';
import { safeTarget } from './workspace.js';
import type { LocalChangeFile, PrivateLocalChangePlan } from './local-change-plan.model.js';

const JSON_LIMIT = 64 * 1048576;
const HTML_LIMIT = 256 * 1048576;
const STORAGE_LIMIT = 1024 * 1048576;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const directory = () => path.join(stateDir(), 'local-change-plans');
const json = (value: unknown) => JSON.stringify(canonicalV4(value));
const exact = (value: object, names: string[]) => Object.keys(value).sort().join(',') === [...names].sort().join(',');
const bytes = (change: FileChange, value: string | null): Buffer | null => value === null ? null : Buffer.from(value, change.encoding ?? 'utf8');

/** Сервер видит только пути, размеры и хэши; исходные строки остаются в приватном плане. */
export function localChangeFiles(changes: FileChange[]): LocalChangeFile[] {
    return changes.map(change => {
        const before = bytes(change, change.before); const after = bytes(change, change.after);
        const binary = [before, after].some(value => value && (value.includes(0) || !Buffer.from(value.toString('utf8')).equals(value)));
        return { path: change.relative, operation: before === null ? 'add' : after === null ? 'remove' : 'replace',
            beforeSha256: before === null ? null : hash(before), afterSha256: after === null ? null : hash(after),
            beforeBytes: before?.length ?? 0, afterBytes: after?.length ?? 0, binary };
    });
}
export function localChangeDigest(plan: PrivateLocalChangePlan): string {
    const { digest: _digest, ...summary } = plan.summary;
    return hash(json({ ...plan, summary }));
}
const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
export function localChangeHtml(plan: PrivateLocalChangePlan): string {
    const items = plan.changes.map((change, index) => {
        const info = plan.summary.files[index]!;
        const text = (value: string | null): string => {
            const buffer = bytes(change, value);
            return buffer === null ? '(файл отсутствует)' : info.binary ? `(бинарный файл: ${buffer.length} байт, SHA-256 ${hash(buffer)})\nBase64:\n${buffer.toString('base64')}` : buffer.toString('utf8');
        };
        return `<section><h2>${escape(change.relative)}</h2><p>${escape(info.operation)} · ${info.beforeBytes} → ${info.afterBytes} байт</p><div><article><h3>До</h3><pre>${escape(text(change.before))}</pre></article><article><h3>После</h3><pre>${escape(text(change.after))}</pre></article></div></section>`;
    }).join('');
    const runtime = plan.summary.runtimeRepairRequired ? '<p>Готовый комплект повреждён или отсутствует. После подтверждения мост повторно загрузит одобренный архив и проверит SHA. Прежние байты кэша сохранятся в закрытом карантине; ошибка загрузки не изменит файлы проекта.</p>' : '';
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Сравнение локальных изменений</title><style>body{font:15px system-ui;margin:2rem;background:#111827;color:#e5e7eb}section{border-top:1px solid #475569;padding:1rem 0}div{display:flex;gap:1rem}article{width:50%;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#1e293b;padding:1rem}h2{overflow-wrap:anywhere}@media(max-width:700px){div{display:block}article{width:100%}}</style></head><body><h1>Сравнение локальных изменений</h1><p>План ${escape(plan.summary.planId)}. Действует до ${escape(plan.summary.expiresAt)}.</p><p>Ручные варианты файлов и конфигурации сохранятся в закрытой резервной копии при применении. Меняются только доказанные файлы и подключения инструмента; прочие настройки и комментарии сохраняются. Применение требует отдельного подтверждения.</p>${runtime}${items || '<p>Файлы проекта не требуют изменений.</p>'}</body></html>`;
}
function validate(plan: PrivateLocalChangePlan): void {
    const extras = plan?.purpose === undefined ? [] : ['purpose', 'sourceId'];
    if (!plan || typeof plan !== 'object' || !exact(plan, ['schemaVersion', 'summary', 'root', 'installationManifest', 'packages', 'changes', 'snapshots', 'reportSha256', ...extras])
        || plan.purpose !== undefined && (!['adopt', 'restore-local'].includes(plan.purpose) || !UUID.test(plan.sourceId ?? ''))
        || plan.schemaVersion !== 1 || typeof plan.root !== 'string' || !path.isAbsolute(plan.root) || !SHA.test(plan.installationManifest) || !SHA.test(plan.reportSha256)) { throw new Error(); }
    validateChanges(plan.changes);
    const summary = plan.summary;
    const summaryExtras = summary?.runtimeRepairRequired === undefined ? [] : ['runtimeRepairRequired'];
    if (!summary || typeof summary !== 'object' || !exact(summary, ['schemaVersion', 'planId', 'revision', 'digest', 'projectId', 'bindingId', 'instanceId', 'assetId', 'assetKind', 'version', 'manifest', 'checkedAt', 'expiresAt', 'status', 'files', ...summaryExtras])
        || summary.runtimeRepairRequired !== undefined && (summary.runtimeRepairRequired !== true || plan.purpose !== undefined)
        || summary.schemaVersion !== 1 || !UUID.test(summary.planId) || summary.revision !== 1 || !SHA.test(summary.digest)
        || typeof summary.projectId !== 'string' || !summary.projectId || summary.projectId.length > 500
        || !SHA.test(summary.bindingId) || !UUID.test(summary.instanceId) || typeof summary.assetId !== 'string' || !summary.assetId || summary.assetId.length > 500
        || !['skill', 'mcp', 'plugin'].includes(summary.assetKind) || !Number.isSafeInteger(summary.version) || summary.version < 1 || !SHA.test(summary.manifest)
        || summary.status !== 'prepared' || new Date(summary.checkedAt).toISOString() !== summary.checkedAt || new Date(summary.expiresAt).toISOString() !== summary.expiresAt
        || Date.parse(summary.expiresAt) - Date.parse(summary.checkedAt) !== 15 * 60000
        || Buffer.byteLength(JSON.stringify(summary)) > 512 * 1024 || plan.changes.some(change => change.relative.length > 1024)
        || json(summary.files) !== json(localChangeFiles(plan.changes))) { throw new Error(); }
    if (!Array.isArray(plan.packages) || !plan.packages.length || plan.packages.length > 20 || plan.packages.some(ref => !ref || !exact(ref, ['kind', 'id', 'version', 'manifest'])
        || !['skill', 'mcp', 'plugin'].includes(ref.kind) || typeof ref.id !== 'string' || !ref.id || ref.id.length > 500 || !Number.isSafeInteger(ref.version) || ref.version < 1 || !SHA.test(ref.manifest))
        || new Set(plan.packages.map(ref => ref.kind + ':' + ref.id)).size !== plan.packages.length
        || !plan.packages.some(ref => ref.kind === summary.assetKind && ref.id === summary.assetId && ref.version === summary.version && ref.manifest === summary.manifest)) { throw new Error(); }
    if (!Array.isArray(plan.snapshots) || plan.snapshots.length > 2000 || new Set(plan.snapshots.map(item => item.relative)).size !== plan.snapshots.length) { throw new Error(); }
    for (const item of plan.snapshots) {
        if (!item || !exact(item, ['relative', 'fingerprint', 'sha256']) || typeof item.relative !== 'string' || item.relative.length > 1024
            || (item.fingerprint === null) !== (item.sha256 === null) || item.fingerprint !== null && (!/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(item.fingerprint) || item.fingerprint.length > 200 || !SHA.test(item.sha256!))) { throw new Error(); }
        validateChanges([{ relative: item.relative, before: null, after: null }]);
    }
    if (plan.changes.some(change => !plan.snapshots.some(item => item.relative === change.relative && item.fingerprint === change.beforeFingerprint
        && item.sha256 === (change.before === null ? null : hash(bytes(change, change.before)!))))) { throw new Error(); }
    if (localChangeDigest(plan) !== summary.digest) { throw new Error(); }
}

/** Бюджет планов отдельный; общий lock сериализует резервирование места между проектами. */
export async function saveLocalChangePlan(plan: PrivateLocalChangePlan, html: string): Promise<void> {
    validate(plan); const text = JSON.stringify(plan); const required = Buffer.byteLength(text) + Buffer.byteLength(html);
    if (Buffer.byteLength(text) > JSON_LIMIT || Buffer.byteLength(html) > HTML_LIMIT) { throw new Error('Локальный план превышает допустимый объём.'); }
    await withRecoveryBudget(plan.root, Math.ceil(required / 2), [], false, async () => {
        await recoveryDirectory(directory()); let stored = 0;
        for await (const entry of await fs.opendir(directory())) {
            const stat = await fs.lstat(path.join(directory(), entry.name));
            if (!stat.isFile() || stat.isSymbolicLink()) { throw new Error('Папка локальных планов содержит небезопасную запись.'); }
            stored += stat.size;
        }
        if (stored + required > STORAGE_LIMIT) { throw new Error('Локальные планы достигли лимита 1 ГиБ. Сверьте и перенесите планы вручную.'); }
        await atomicText(path.join(directory(), plan.summary.planId + '.html'), html, 0o600);
        await atomicText(path.join(directory(), plan.summary.planId + '.json'), text, 0o600);
    });
}
export async function readLocalChangePlan(planId: string): Promise<PrivateLocalChangePlan> {
    if (!UUID.test(planId)) { throw new Error('Некорректный ID локального плана.'); }
    try {
        await recoveryDirectory(directory(), false);
        const plan = JSON.parse(await readBoundedUtf8(path.join(directory(), planId + '.json'), JSON_LIMIT)) as PrivateLocalChangePlan;
        validate(plan); if (plan.summary.planId !== planId) { throw new Error(); } return plan;
    } catch { throw new Error('Локальный план отсутствует, повреждён или изменён. Подготовьте сравнение заново.'); }
}
export async function verifyLocalChangeSnapshot(plan: PrivateLocalChangePlan): Promise<void> {
    for (const item of plan.snapshots) {
        const file = await safeTarget(plan.root, item.relative);
        const current = await readBoundedSnapshot(file, installationReadLimit(item.relative)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return null; } throw error; });
        await safeTarget(plan.root, item.relative);
        if ((current?.fingerprint ?? null) !== item.fingerprint || (current === null ? null : hash(current.bytes)) !== item.sha256) { throw new Error('Файл изменился после сравнения: ' + item.relative + '. Подготовьте план заново.'); }
    }
}
/** Абсолютный путь выдаётся только локальному CLI и никогда не входит в серверный summary. */
export async function localChangeReportPath(planId: string): Promise<string> {
    const plan = await readLocalChangePlan(planId); const file = path.join(directory(), planId + '.html');
    if (hash(await readBoundedUtf8(file, HTML_LIMIT)) !== plan.reportSha256) { throw new Error('Локальный отчёт изменён. Подготовьте сравнение заново.'); }
    return file;
}
