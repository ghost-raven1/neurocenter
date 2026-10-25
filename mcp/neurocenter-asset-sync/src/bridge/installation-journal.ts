import path from 'node:path';
import { hash, stateDir } from './state.js';
import { installationReadLimit, JOURNAL_BYTES_LIMIT } from './installation-limits.js';
import { canonicalV4 } from './package.js';
import type { PackageRef } from './install-set.js';

export interface FileChange {
    relative: string; before: string | null; after: string | null; encoding?: 'base64';
    beforeFingerprint?: string | null;
    /** Отсутствие поля в старом журнале означает неизвестные исходные права. */
    beforeMode?: number;
}
export interface ChangeIdentity {
    action: 'install' | 'uninstall'; assetKey: string; manifest: string; result?: Record<string, unknown>;
    recovery?: RecoveryDescriptor;
}
export interface RecoveryDescriptor {
    schemaVersion: 1; projectId: string; instanceId: string; bindingId: string; asset: PackageRef;
    installationManifest: string; packages: PackageRef[]; createdAt: string;
}
export interface Journal extends ChangeIdentity {
    version: 1; root: string; id: string; state: 'prepared' | 'committed' | 'rolled-back'; changes: FileChange[];
    job?: { id: string; lease: string; deviceId?: string };
}
export const journalDirectory = (root: string): string => path.join(stateDir(), 'file-changes', hash(root));

/** Новые копии имеют точную привязку; прежние журналы v1 по-прежнему читаются без неё. */
export function validateRecovery(value: RecoveryDescriptor): void {
    const ref = (item: PackageRef): boolean => !!item && Object.keys(item).sort().join(',') === 'id,kind,manifest,version'
        && ['skill','mcp','plugin'].includes(item.kind) && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 500
        && Number.isSafeInteger(item.version) && item.version > 0 && /^[a-f0-9]{64}$/.test(item.manifest);
    if (!value || Object.keys(value).sort().join(',') !== 'asset,bindingId,createdAt,installationManifest,instanceId,packages,projectId,schemaVersion'
        || value.schemaVersion !== 1 || typeof value.projectId !== 'string' || !value.projectId || value.projectId.length > 500
        || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.instanceId) || !/^[a-f0-9]{64}$/.test(value.bindingId)
        || !ref(value.asset) || !Array.isArray(value.packages) || value.packages.length < 1 || value.packages.length > 20 || value.packages.some(item => !ref(item))
        || new Set(value.packages.map(item => item.kind + ':' + item.id)).size !== value.packages.length
        || !value.packages.some(item => JSON.stringify(canonicalV4(item)) === JSON.stringify(canonicalV4(value.asset)))
        || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt) { throw new Error('Повреждено описание локальной резервной копии.'); }
    const packages = [...value.packages].sort((a,b) => a.kind === b.kind ? a.id < b.id ? -1 : a.id === b.id ? 0 : 1 : a.kind < b.kind ? -1 : 1);
    const expected = packages.length === 1 ? value.asset.manifest : hash(JSON.stringify(canonicalV4({schemaVersion:1,root:value.asset,packages})));
    if (value.installationManifest !== expected) { throw new Error('Набор локальной резервной копии изменён.'); }
}

/** Ограничения действуют до pending.json, а не только при чтении после аварии. */
export function validateChanges(changes: FileChange[]): void {
    if (!Array.isArray(changes) || changes.length > 512) { throw new Error('Журнал превышает лимит 512 изменений.'); }
    const paths = new Set<string>(); let bytes = 0;
    for (const change of changes) {
        if (!change || typeof change.relative !== 'string' || !change.relative || change.relative.startsWith('/') || change.relative.includes('\\')
            || change.relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':') || part.includes('\0'))
            || ![undefined, 'base64'].includes(change.encoding) || ![change.before, change.after].every(value => value === null || typeof value === 'string')
            || change.encoding === 'base64' && [change.before, change.after].some(value => value !== null && Buffer.from(value, 'base64').toString('base64') !== value)
            || change.beforeMode !== undefined && (change.before === null || !Number.isSafeInteger(change.beforeMode) || change.beforeMode < 0 || change.beforeMode > 0o777)
            || change.beforeFingerprint !== undefined && change.beforeFingerprint !== null && (typeof change.beforeFingerprint !== 'string'
                || change.beforeFingerprint.length > 200 || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(change.beforeFingerprint))) {
            throw new Error('Некорректное изменение файла в журнале установки.');
        }
        const key = change.relative.normalize('NFC').toLowerCase();
        if (paths.has(key) || [...paths].some(other => other.startsWith(key + '/') || key.startsWith(other + '/'))) { throw new Error('Повтор пути в журнале установки.'); }
        paths.add(key);
        bytes += [change.before, change.after].reduce((sum: number, value) => sum + (value === null ? 0 : Buffer.byteLength(value, change.encoding ?? 'utf8')), 0);
    }
    if (bytes > 32 * 1048576) { throw new Error('Журнал превышает лимит 32 МБ.'); }
    for (const change of changes) {
        if ([change.before, change.after].some(value => value !== null && Buffer.byteLength(value, change.encoding ?? 'utf8') > installationReadLimit(change.relative))) {
            throw new Error('Файл в журнале превышает допустимый размер локальной записи.');
        }
    }
}

export function encodeJournal(journal: Journal): string {
    if (journal.recovery !== undefined) {
        validateRecovery(journal.recovery);
        if (journal.assetKey !== hash(journal.recovery.asset.kind + ':' + journal.recovery.asset.id).slice(0,24)
            || journal.manifest !== journal.recovery.installationManifest) { throw new Error('Описание копии не соответствует журналу.'); }
    }
    const text = JSON.stringify(journal);
    if (Buffer.byteLength(text) > JOURNAL_BYTES_LIMIT) { throw new Error('JSON журнала превышает лимит 64 МиБ.'); }
    return text;
}

/** Повреждённый журнал не разрешает откат или импорт произвольных локальных путей. */
export function parseJournal(text: string, root: string): Journal {
    const damaged = () => new Error('Повреждён локальный журнал установки. Проверьте резервную копию: ' + journalDirectory(root));
    try {
        if (Buffer.byteLength(text) > JOURNAL_BYTES_LIMIT) { throw damaged(); }
        const journal = JSON.parse(text) as Journal | null;
        if (!journal || typeof journal !== 'object' || Array.isArray(journal) || journal.version !== 1 || journal.root !== root
            || !/^[-a-f0-9]{36}$/.test(journal.id) || !['prepared', 'committed', 'rolled-back'].includes(journal.state)
            || !['install', 'uninstall'].includes(journal.action) || !/^[a-f0-9]{24}$/.test(journal.assetKey) || !/^[a-f0-9]{64}$/.test(journal.manifest)
            || journal.job !== undefined && (!/^[-a-f0-9]{36}$/.test(journal.job.id) || !/^[-a-f0-9]{36}$/.test(journal.job.lease)
                || journal.job.deviceId !== undefined && !/^[-a-f0-9]{36}$/.test(journal.job.deviceId)
                || !journal.result || typeof journal.result.projectId !== 'string')) { throw damaged(); }
        validateChanges(journal.changes);
        if (journal.recovery !== undefined) {
            validateRecovery(journal.recovery);
            if (journal.assetKey !== hash(journal.recovery.asset.kind + ':' + journal.recovery.asset.id).slice(0,24)
                || journal.manifest !== journal.recovery.installationManifest) { throw damaged(); }
        }
        return journal;
    } catch { throw damaged(); }
}
