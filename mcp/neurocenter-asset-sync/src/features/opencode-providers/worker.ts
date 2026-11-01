import { OPENCODE_PROVIDER_JOBS, type OpenCodeProviderDescriptor } from './contract.js';
import { prepareOpenCodeProvider, openOpenCodeProvider, getOpenCodeProviderStatus } from './index.js';
import type { TAuthorize } from './context.js';
import type { IPackage } from '../../bridge/package.js';
import { prepareJobRuntimeArtifacts } from '../../bridge/job-runtime-artifacts.js';
import { connectorPackage } from './connector.js';
export { OPENCODE_PROVIDER_JOBS };
export interface IProviderPayload {
    descriptor?: OpenCodeProviderDescriptor;
    preparationJobId?: string;
    preparationId?: string;
    expiresAt?: string;
    connectorPackage?: IPackage;
}
/** A completed open lease never authorizes a later local form save. */
export async function runProviderJob(
    job: { id: string; kind: string; project_id?: string; payload: IProviderPayload },
    authorize: TAuthorize,
    authorizeSave: TAuthorize,
) {
    const descriptor = job.payload.descriptor;
    if (!descriptor || descriptor.projectId !== job.project_id)
        throw new Error('Контекст провайдера не соответствует проекту.');
    const pkg =
        descriptor.providerKind === 'codex-bridge'
            ? connectorPackage(descriptor, job.payload.connectorPackage)
            : undefined;
    if (job.kind === 'prepare-opencode-provider') {
        if (pkg) await prepareJobRuntimeArtifacts([pkg], authorize, async () => {});
        return prepareOpenCodeProvider(descriptor, authorize, pkg);
    }
    if (job.kind === 'get-opencode-provider-status') return getOpenCodeProviderStatus(descriptor, authorize, pkg);
    if (job.kind === 'open-opencode-provider')
        return openOpenCodeProvider(
            descriptor,
            {
                preparationId: job.payload.preparationId ?? '',
                expiresAt: job.payload.expiresAt ?? '',
                openJobId: job.id,
                authorizeSave,
                connectorPackage: pkg,
            },
            authorize,
        );
    throw new Error('Неизвестное действие настройки провайдера.');
}
