import { randomUUID } from 'node:crypto';
import { hash } from '../../bridge/state.js';
import { openVerificationPage } from '../../bridge/open-browser.js';
import { readPrivateConfiguration, writePrivateConfiguration } from '../local-configuration/private-store.js';
import { providerContext, sameDescriptor, stale, type Authorize } from './context.js';
import {
    providerReportIdentity,
    type OpenCodeProviderDescriptor,
    type OpenCodeProviderPreparation,
} from './contract.js';
import { providerStatus } from './engine.js';
import { startProviderSession } from './server.js';
import type { Package } from '../../bridge/package.js';
export { authorizeManagedProvider } from './authorization.js';
interface Preparation {
    descriptor: OpenCodeProviderDescriptor;
    preparationId: string;
    expiresAt: string;
    site: string;
    openJobId?: string;
    connectorPackage?: Package;
}
const preparationKey = (id: string) => hash('opencode-provider-preparation:' + id);
/** Preparation is inert and private; no URL, browser capability or credential enters a completion. */
export async function prepareOpenCodeProvider(
    input: unknown,
    authorize: Authorize,
    connectorPackage?: Package,
): Promise<OpenCodeProviderPreparation> {
    const context = await providerContext(input, authorize, connectorPackage),
        preparationId = randomUUID(),
        expiresAt = new Date(Date.now() + 900000).toISOString();
    await writePrivateConfiguration(
        preparationKey(preparationId),
        {
            descriptor: context.descriptor,
            site: context.site,
            preparationId,
            expiresAt,
            ...(connectorPackage ? { connectorPackage } : {}),
        },
        undefined,
    );
    return { ...providerReportIdentity(context.descriptor), preparationId, expiresAt };
}
export async function openOpenCodeProvider(
    input: unknown,
    options: {
        preparationId: string;
        expiresAt: string;
        openJobId: string;
        authorizeSave: Authorize;
        open?: (url: string) => Promise<boolean>;
        connectorPackage?: Package;
    },
    authorize: Authorize,
) {
    if (!/^[a-f0-9-]{36}$/.test(options.preparationId) || !/^[a-f0-9-]{36}$/.test(options.openJobId)) throw stale();
    const context = await providerContext(input, authorize, options.connectorPackage),
        prepared = await readPrivateConfiguration<Preparation>(preparationKey(options.preparationId));
    if (
        !prepared ||
        prepared.site !== context.site ||
        prepared.preparationId !== options.preparationId ||
        prepared.expiresAt !== options.expiresAt ||
        !sameDescriptor(prepared.descriptor, context.descriptor) ||
        Date.parse(prepared.expiresAt) <= Date.now() ||
        Date.parse(prepared.expiresAt) > Date.now() + 900000 ||
        !Number.isFinite(Date.parse(prepared.expiresAt))
    )
        throw stale();
    if (prepared.openJobId && prepared.openJobId !== options.openJobId) throw stale();
    if (!prepared.openJobId)
        await writePrivateConfiguration(
            preparationKey(options.preparationId),
            { ...prepared, openJobId: options.openJobId },
            prepared,
        );
    await startProviderSession(
        context,
        prepared.preparationId,
        prepared.expiresAt,
        options.authorizeSave,
        options.open ?? openVerificationPage,
        options.openJobId,
    );
    return {
        ...providerReportIdentity(context.descriptor),
        preparationId: prepared.preparationId,
        expiresAt: prepared.expiresAt,
        opened: true as const,
    };
}
export async function getOpenCodeProviderStatus(input: unknown, authorize: Authorize, connectorPackage?: Package) {
    return providerStatus(await providerContext(input, authorize, connectorPackage), authorize);
}
