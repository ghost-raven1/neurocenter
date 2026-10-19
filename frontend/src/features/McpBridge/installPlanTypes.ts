export interface IInstallPlanInput {
    projectId: string;
    assetKind: 'skill' | 'mcp' | 'plugin';
    assetId: string;
    version: number;
}

export interface IInstallPlanRequirements {
    mcp?: string[];
    plugins?: string[];
    dependencies?: IDependencyPin[];
}

/** Каждый участник комплекта показывается со своим содержимым и отдельным хэшем. */
export interface IInstallPlanPackage {
    schemaVersion?: 2 | 3 | 4 | 5;
    kind: 'skill' | 'mcp' | 'plugin';
    id: string;
    name: string;
    version: number;
    manifest: string;
    files: Array<{ path: string; size: number; sha256: string; content: string; encoding?: string }>;
    config: Record<string, unknown> | null;
    requirements: IInstallPlanRequirements;
}

/** Разрешение относится к точному манифесту, а не ко всем будущим версиям инструмента. */
export interface IInstallPlan extends IInstallPlanInput {
    schemaVersion?: 2 | 3 | 4 | 5;
    id: string;
    /** Хэш всего комплекта при наличии packages, иначе хэш одиночного пакета. */
    manifest: string;
    status: 'pending' | 'approved' | 'revoked';
    revision: number;
    approvedBy: string | null;
    files: IInstallPlanPackage['files'];
    config: Record<string, unknown> | null;
    requirements: IInstallPlanRequirements;
    packages?: IInstallPlanPackage[];
}
import type { IDependencyPin } from '../../core/api/interfaces';

