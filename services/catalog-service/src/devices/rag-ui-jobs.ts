import type { PoolClient } from 'pg';
import type { IDevice } from './device-store';
import type { DeviceInstallations } from './device-installations';
import type { InstallPlans } from './install-plans';
import type { IJob, IJobInput } from './device-job.model';
import { ragInstallationJobPayload, assertRagInstallation } from './rag-installation-authority';

/** Opening remains a UI-only action; an engine declaration cannot authorize a window. */
export async function ragUiJobPayload(
    installations: DeviceInstallations,
    plans: InstallPlans,
    device: IDevice,
    input: IJobInput,
) {
    if (input.kind !== 'open-rag-ui') return undefined;
    return ragInstallationJobPayload(installations, plans, device, input, 'ui');
}
export async function assertRagUiJob(
    installations: DeviceInstallations,
    plans: InstallPlans,
    device: IDevice,
    job: Pick<IJob, 'kind' | 'payload' | 'project_id'>,
    db?: Pick<PoolClient, 'query'>,
) {
    if (job.kind !== 'open-rag-ui') return;
    await assertRagInstallation(installations, plans, device, job, 'ui', db);
}
