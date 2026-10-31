import { ConflictException } from '@nestjs/common';

interface Source {
    projectId: string | null;
    bindingId?: unknown;
    instanceId?: unknown;
    package?: { plugin: { id: string; kind?: string; version: number }; manifest: { sha256: string } };
}
export const inventoryReasons = [
    'managed-receipt',
    'managed-project-learning',
    'unmanaged-files',
    'unmanaged-config',
    'receipt-invalid',
    'receipt-missing',
    'file-mismatch',
    'config-mismatch',
    'config-invalid',
    'unsafe-path',
    'read-failed',
    'read-limit',
    'snapshot-changed',
    'entry-limit',
    'project-busy',
    'binding-changed',
    'unknown-layout',
];
export const variantReasons = [
    'ready',
    'legacy-unverified',
    'different-installation',
    'different-instance',
    'shared-dependency',
    'no-restorable-files',
    'invalid-backup',
    'limit-exceeded',
];
export const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const relativePath = (value: unknown): value is string =>
    typeof value === 'string' &&
    !!value &&
    value.length <= 1024 &&
    !/[\\:\x00-\x1f]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..');
const iso = (value: unknown): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const fail = (): never => {
    throw new ConflictException('Локальный отчёт содержит неподдерживаемые данные или относится к другой папке.');
};
export interface ProjectInventory {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    instanceId: string;
    scanId: string;
    digest: string;
    checkedAt: string;
    expiresAt: string;
    complete: boolean;
    issues: string[];
    entries: Array<{ candidateId: string; kind: string; path: string; state: string; reason: string }>;
}

/** На сервер попадают только ограниченные метаданные, без команд, содержимого и абсолютных путей. */
export function assertProjectInventory(value: unknown, source: Source): asserts value is ProjectInventory {
    if (
        !object(value) ||
        !fields(value, [
            'schemaVersion',
            'projectId',
            'bindingId',
            'instanceId',
            'scanId',
            'digest',
            'checkedAt',
            'expiresAt',
            'complete',
            'issues',
            'entries',
        ]) ||
        value.schemaVersion !== 1 ||
        value.projectId !== source.projectId ||
        value.bindingId !== source.bindingId ||
        !sha(value.bindingId) ||
        value.instanceId !== source.instanceId ||
        !uuid(value.instanceId) ||
        !uuid(value.scanId) ||
        !sha(value.digest) ||
        !iso(value.checkedAt) ||
        !iso(value.expiresAt) ||
        Date.parse(value.expiresAt) - Date.parse(value.checkedAt) !== 15 * 60000 ||
        typeof value.complete !== 'boolean' ||
        !Array.isArray(value.issues) ||
        value.issues.length > inventoryReasons.length ||
        value.issues.some((reason) => typeof reason !== 'string' || !inventoryReasons.includes(reason)) ||
        !Array.isArray(value.entries) ||
        value.entries.length > 200 ||
        Buffer.byteLength(JSON.stringify(value)) > 512 * 1024
    )
        return fail();
    const ids = new Set<string>();
    for (const entry of value.entries) {
        if (
            !object(entry) ||
            !fields(entry, ['candidateId', 'kind', 'path', 'state', 'reason']) ||
            !uuid(entry.candidateId) ||
            ids.has(entry.candidateId) ||
            !['skill', 'mcp', 'plugin', 'unknown'].includes(String(entry.kind)) ||
            !relativePath(entry.path) ||
            !['managed', 'unmanaged', 'damaged', 'unsafe', 'unreadable'].includes(String(entry.state)) ||
            !inventoryReasons.includes(String(entry.reason))
        )
            return fail();
        ids.add(entry.candidateId);
    }
}
export function assertLocalVariants(value: unknown, source: Source): void {
    if (
        !object(value) ||
        !fields(value, [
            'schemaVersion',
            'projectId',
            'bindingId',
            'instanceId',
            'assetId',
            'assetKind',
            'version',
            'manifest',
            'checkedAt',
            'complete',
            'entries',
        ]) ||
        value.schemaVersion !== 1 ||
        value.projectId !== source.projectId ||
        value.bindingId !== source.bindingId ||
        !sha(value.bindingId) ||
        value.instanceId !== source.instanceId ||
        !uuid(value.instanceId) ||
        value.assetId !== source.package?.plugin.id ||
        value.assetKind !== source.package?.plugin.kind ||
        value.version !== source.package?.plugin.version ||
        value.manifest !== source.package?.manifest.sha256 ||
        !iso(value.checkedAt) ||
        typeof value.complete !== 'boolean' ||
        !Array.isArray(value.entries) ||
        value.entries.length > 100 ||
        Buffer.byteLength(JSON.stringify(value)) > 100000
    )
        return fail();
    const ids = new Set<string>();
    for (const entry of value.entries) {
        if (
            !object(entry) ||
            !fields(entry, ['recoveryId', 'createdAt', 'files', 'eligible', 'reason']) ||
            !uuid(entry.recoveryId) ||
            ids.has(entry.recoveryId) ||
            !iso(entry.createdAt) ||
            !Number.isSafeInteger(entry.files) ||
            Number(entry.files) < 0 ||
            Number(entry.files) > 512 ||
            typeof entry.eligible !== 'boolean' ||
            !variantReasons.includes(String(entry.reason)) ||
            entry.eligible !== (entry.reason === 'ready')
        )
            return fail();
        ids.add(entry.recoveryId);
    }
}
