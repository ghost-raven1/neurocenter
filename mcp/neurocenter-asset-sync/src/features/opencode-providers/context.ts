import { isDeepStrictEqual } from 'node:util';
import { hash, hub, readState, type Credentials } from '../../bridge/state.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { normalizeProviderDescriptor, type OpenCodeProviderDescriptor } from './contract.js';
import type { Package } from '../../bridge/package.js';
export type Authorize = () => Promise<unknown>;
export const stale = () => new Error('Настройка провайдера устарела. Повторите подготовку для текущей папки и модели.');
/** Every local operation keeps the exact device, site, physical folder and server-pinned descriptor. */
export async function providerContext(input: unknown, authorize: Authorize, connectorPackage?: Package) {
    const descriptor = normalizeProviderDescriptor(input),
        site = hub();
    await authorize();
    const root = await projectFolder(descriptor.projectId);
    const assertCurrent = async () => {
        if (
            hub() !== site ||
            (await readState<Credentials>('credentials'))?.deviceId !== descriptor.deviceId ||
            (await projectFolder(descriptor.projectId)) !== root ||
            (await projectBindingId(descriptor.projectId)) !== descriptor.bindingId ||
            (await projectInstanceId(descriptor.projectId)) !== descriptor.instanceId
        )
            throw stale();
    };
    await assertCurrent();
    return {
        descriptor,
        root,
        site,
        assertCurrent,
        connectorPackage,
        key: hash(
            JSON.stringify([
                site,
                descriptor.deviceId,
                descriptor.projectId,
                descriptor.instanceId,
                descriptor.providerId,
            ]),
        ),
    };
}
export type ProviderContext = Awaited<ReturnType<typeof providerContext>>;
export const sameDescriptor = (a: OpenCodeProviderDescriptor, b: OpenCodeProviderDescriptor) => isDeepStrictEqual(a, b);
