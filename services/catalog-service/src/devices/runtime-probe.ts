import { ConflictException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { validConfigurationRevisions, type ConfigurationRevision } from './mcp-config-reports';

export const RUNTIME_PROBE_CODES = [
    'verified',
    'not-approved',
    'invalid-package',
    'installation-not-current',
    'inspection-busy',
    'authorization-denied',
    'runtime-unavailable',
    'runtime-mismatch',
    'unsupported-platform',
    'managed-configuration',
    'dependency-required',
    'configuration-required',
    'invalid-skill',
    'entrypoint-unsupported',
    'external-command-unsupported',
    'unsafe-environment',
    'mcp-connect-failed',
    'mcp-list-failed',
    'plugin-initialization-failed',
    'timeout',
    'output-limit',
    'probe-failed',
    'configuration-changed',
] as const;
export interface RuntimeProbeResult {
    schemaVersion: 1;
    projectId: string;
    bindingId: string;
    assetId: string;
    assetKind: string;
    version: number;
    manifest: string;
    approvalManifest: string;
    checkedAt: string;
    engineVersion: '1.14.48';
    engineSha256: string;
    status: 'not_checked' | 'passed' | 'needs_configuration' | 'failed' | 'unsupported' | 'stale' | 'busy';
    code: (typeof RUNTIME_PROBE_CODES)[number];
    counts: {
        packages: number;
        files: number;
        skills: number;
        mcp: number;
        tools: number;
        resources: number;
        prompts: number;
        pluginsInitialized: number;
    };
    configurationRevisions?: ConfigurationRevision[];
}
interface ProbePackage {
    plugin: { id: string; kind?: string; version: number };
    manifest: { sha256: string };
    files?: unknown[];
}
interface Source {
    projectId: string | null;
    bindingId?: string;
    consentManifest?: string;
    package?: ProbePackage;
    installSet?: { packages: ProbePackage[] };
    configurationRevisions?: ConfigurationRevision[];
}
const fields = [
    'schemaVersion',
    'projectId',
    'bindingId',
    'assetId',
    'assetKind',
    'version',
    'manifest',
    'approvalManifest',
    'checkedAt',
    'engineVersion',
    'engineSha256',
    'status',
    'code',
    'counts',
];
const countFields = ['packages', 'files', 'skills', 'mcp', 'tools', 'resources', 'prompts', 'pluginsInitialized'];

/** Диагностика публикует только фиксированные статусы и счётчики, без stdout, секретов и путей. */
export function assertRuntimeProbe(
    value: unknown,
    source: Source,
    failed = false,
): asserts value is RuntimeProbeResult {
    const result = value as RuntimeProbeResult | null;
    const expectedFields = source.configurationRevisions ? [...fields, 'configurationRevisions'] : fields;
    if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).length !== expectedFields.length ||
        Object.keys(result).some((key) => !expectedFields.includes(key)) ||
        result.schemaVersion !== 1 ||
        result.projectId !== source.projectId ||
        result.bindingId !== source.bindingId ||
        !/^[a-f0-9]{64}$/.test(result.bindingId) ||
        result.assetId !== source.package?.plugin.id ||
        result.assetKind !== source.package?.plugin.kind ||
        result.version !== source.package?.plugin.version ||
        result.manifest !== source.package?.manifest.sha256 ||
        result.approvalManifest !== source.consentManifest ||
        result.engineVersion !== '1.14.48' ||
        (result.engineSha256 !== '' && !/^[a-f0-9]{64}$/.test(result.engineSha256)) ||
        typeof result.checkedAt !== 'string' ||
        !Number.isFinite(Date.parse(result.checkedAt)) ||
        new Date(result.checkedAt).toISOString() !== result.checkedAt ||
        !['not_checked', 'passed', 'needs_configuration', 'failed', 'unsupported', 'stale', 'busy'].includes(
            result.status,
        ) ||
        !RUNTIME_PROBE_CODES.includes(result.code) ||
        !result.counts ||
        typeof result.counts !== 'object' ||
        Array.isArray(result.counts) ||
        Object.keys(result.counts).length !== countFields.length ||
        Object.keys(result.counts).some((key) => !countFields.includes(key)) ||
        Object.values(result.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 20000) ||
        result.counts.packages > 20 ||
        result.counts.files > 200 ||
        result.counts.skills + result.counts.mcp + result.counts.pluginsInitialized !== result.counts.packages ||
        (result.status === 'passed'
            ? result.code !== 'verified' || result.engineSha256.length !== 64 || result.counts.packages < 1
            : result.code === 'verified') ||
        (failed && result.status === 'passed') ||
        (source.configurationRevisions &&
            (!validConfigurationRevisions(result.configurationRevisions) ||
                !isDeepStrictEqual(result.configurationRevisions, source.configurationRevisions)))
    ) {
        throw new ConflictException(
            'Результат запуска не соответствует одобренной установке или содержит неподдерживаемые данные.',
        );
    }
    if (result.status === 'passed') {
        const packages = source.installSet?.packages ?? (source.package ? [source.package] : []);
        if (
            !Array.isArray(packages) ||
            packages.length === 0 ||
            packages.some((pkg) => !Array.isArray(pkg.files)) ||
            result.counts.packages !== packages.length ||
            result.counts.files !== packages.reduce((total, pkg) => total + pkg.files!.length, 0) ||
            result.counts.skills !== packages.filter((pkg) => pkg.plugin.kind === 'skill').length ||
            result.counts.mcp !== packages.filter((pkg) => pkg.plugin.kind === 'mcp').length ||
            result.counts.pluginsInitialized !== packages.filter((pkg) => pkg.plugin.kind === 'plugin').length
        ) {
            throw new ConflictException('Успешная диагностика должна подтверждать весь закреплённый набор.');
        }
    }
}
