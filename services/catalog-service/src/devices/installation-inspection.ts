import { ConflictException } from '@nestjs/common';

export const INSPECTION_ISSUES = [
    'inspection-busy','binding-changed','receipt-missing','receipt-invalid','receipt-mismatch',
    'ledger-missing','ledger-invalid','ledger-mismatch','file-missing','file-modified','file-unsafe',
    'config-missing','config-invalid','config-modified','config-ambiguous','limit-exceeded',
    'read-failed','snapshot-changed','inspection-failed','runtime-path-unverified',
] as const;
export interface InstallationInspection {
    schemaVersion: 1; projectId: string; bindingId: string; assetId: string;
    assetKind: string; version: number; manifest: string; checkedAt: string;
    readiness: 'unverified'; state: 'checked' | 'busy';
    status: 'synced' | 'modified' | 'missing' | 'unknown';
    issues: Array<typeof INSPECTION_ISSUES[number]>;
}
interface Source {
    projectId: string | null; bindingId?: string;
    package?: { plugin?: { id: string; kind?: string; version: number }; manifest?: { sha256: string } };
}
const fields = ['schemaVersion','projectId','bindingId','assetId','assetKind','version','manifest','checkedAt','readiness','state','status','issues'];

/** Принимает только результат исходной сверки без файлов, путей, настроек и обещания запуска. */
export function assertInstallationInspection(value: unknown, source: Source, failed = false): asserts value is InstallationInspection {
    const result = value as InstallationInspection | null;
    const pkg = source.package;
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).length !== fields.length || Object.keys(result).some(key => !fields.includes(key))
        || result.schemaVersion !== 1 || result.projectId !== source.projectId || result.bindingId !== source.bindingId
        || typeof result.bindingId !== 'string' || !/^[a-f0-9]{64}$/.test(result.bindingId)
        || !pkg?.plugin || !pkg.manifest || result.assetId !== pkg.plugin.id || result.assetKind !== pkg.plugin.kind
        || result.version !== pkg.plugin.version || result.manifest !== pkg.manifest.sha256
        || result.readiness !== 'unverified' || !['checked','busy'].includes(result.state)
        || !['synced','modified','missing','unknown'].includes(result.status)
        || typeof result.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.checkedAt)
        || !Number.isFinite(Date.parse(result.checkedAt)) || new Date(result.checkedAt).toISOString() !== result.checkedAt
        || !Array.isArray(result.issues) || result.issues.length > INSPECTION_ISSUES.length
        || result.issues.some(issue => !INSPECTION_ISSUES.includes(issue)) || new Set(result.issues).size !== result.issues.length
        || (result.status === 'synced' ? result.state !== 'checked' || result.issues.length !== 0 : result.issues.length === 0)
        || (result.state === 'busy' && (result.status !== 'unknown' || !result.issues.some(issue => ['inspection-busy','snapshot-changed','binding-changed'].includes(issue))))
        || (failed && result.status !== 'unknown')) {
        throw new ConflictException('Результат проверки не соответствует исходной установке или содержит неподдерживаемые данные.');
    }
}
