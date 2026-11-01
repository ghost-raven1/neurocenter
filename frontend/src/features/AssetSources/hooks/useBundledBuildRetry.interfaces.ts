import type { useToolBuild } from '../../../modules/Store/packaging/hooks/useToolBuild';
import type { usePackagingPublication } from '../../../modules/Store/packaging/hooks/usePackagingPublication';
import type { IBundledBuildRecovery } from '../../../modules/Store/packaging/interfaces';
import type { IBundledSourcePlan } from '../interfaces';

export interface IBundledBuildRetryOptions {
    scope: string;
    recoverBuildId?: string;
    prepareId?: string;
    captureOwner: () => () => boolean;
    plans: IBundledSourcePlan[];
    blocked: boolean;
    enabled: boolean;
    build: ReturnType<typeof useToolBuild>;
    publication: ReturnType<typeof usePackagingPublication>;
    onPrepared: (request: IBundledBuildRecovery, plan: IBundledSourcePlan) => void;
}
