import { hub, readState, type Credentials } from '../../bridge/state.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { normalizeProjectConfigurationSession } from './contract.js';
export type Authorize = () => Promise<unknown>;
export const unavailable = () =>
    Object.assign(
        new Error(
            'Мастер недоступен: срок, доступ или папка изменились. Черновик в форме сохранён; откройте мастер заново после проверки прав.',
        ),
        { code: 'PROJECT_CONFIGURATION_UNAVAILABLE' },
    );
/** Local scope is checked separately from the fresh server permit, including after the opening job ACK. */
export async function configurationContext(input: unknown, authorize: Authorize) {
    const descriptor = normalizeProjectConfigurationSession(input),
        site = hub();
    await authorize();
    const root = await projectFolder(descriptor.projectId);
    const assertCurrent = async () => {
        if (
            hub() !== site ||
            Date.parse(descriptor.expiresAt) <= Date.now() ||
            Date.parse(descriptor.expiresAt) > Date.now() + 900000 ||
            (await readState<Credentials>('credentials'))?.deviceId !== descriptor.deviceId ||
            (await projectFolder(descriptor.projectId)) !== root ||
            (await projectBindingId(descriptor.projectId)) !== descriptor.bindingId ||
            (await projectInstanceId(descriptor.projectId)) !== descriptor.instanceId
        )
            throw unavailable();
    };
    await assertCurrent();
    return { descriptor, root, site, assertCurrent };
}
export type ConfigurationContext = Awaited<ReturnType<typeof configurationContext>>;
