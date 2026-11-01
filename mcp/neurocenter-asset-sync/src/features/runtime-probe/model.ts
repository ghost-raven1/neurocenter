import type { IInstallSet, IPackageRef } from '../../bridge/install-set.js';

export type TRuntimeProbeStatus =
    'not_checked' | 'passed' | 'needs_configuration' | 'failed' | 'unsupported' | 'stale' | 'busy';
export type TRuntimeProbeCode =
    | 'verified'
    | 'not-approved'
    | 'invalid-package'
    | 'installation-not-current'
    | 'inspection-busy'
    | 'authorization-denied'
    | 'runtime-unavailable'
    | 'runtime-mismatch'
    | 'unsupported-platform'
    | 'managed-configuration'
    | 'dependency-required'
    | 'configuration-required'
    | 'invalid-skill'
    | 'entrypoint-unsupported'
    | 'external-command-unsupported'
    | 'unsafe-environment'
    | 'mcp-connect-failed'
    | 'mcp-list-failed'
    | 'plugin-initialization-failed'
    | 'timeout'
    | 'output-limit'
    | 'probe-failed'
    | 'configuration-changed';

export interface IConfigurationRevision {
    assetId: string;
    manifest: string;
    revision: string | null;
}

export interface IRuntimeProbeInput {
    projectId: string;
    bindingId: string;
    target: IPackageRef;
    /** У одиночного пакета manifest равен SHA пакета, у графа — SHA всего набора. */
    frozenSet: IInstallSet;
    consentManifest: string;
    openCode: { path: string; version: '1.14.48'; sha256: string };
    /** Повторная серверная авторизация непосредственно перед каждым запуском процесса. */
    authorize: () => Promise<void>;
    /** Ревизии настроенных MCP всего frozen-графа, без значений или хэшей секретов. */
    configurationRevisions?: IConfigurationRevision[];
}
export interface IRuntimeProbeResult {
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
    status: TRuntimeProbeStatus;
    code: TRuntimeProbeCode;
    configurationRevisions?: IConfigurationRevision[];
    /** passed описывает эти проверки, а не выполнение произвольных hooks или tools. */
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
}

/** Внутреннее исключение содержит только фиксированный код, без вывода проверяемого кода. */
export class ProbeError extends Error {
    constructor(
        readonly status: TRuntimeProbeStatus,
        readonly code: TRuntimeProbeCode,
    ) {
        super(code);
    }
}
