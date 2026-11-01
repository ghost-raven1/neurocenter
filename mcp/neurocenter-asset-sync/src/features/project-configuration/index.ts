import { openVerificationPage } from '../../bridge/open-browser.js';
import { configurationContext, type TAuthorize } from './context.js';
import { startConfigurationSession } from './server.js';
/** The server receives opening identity only; edits, previews and recovery stay on this computer. */
export async function openProjectConfiguration(
    input: unknown,
    authorize: TAuthorize,
    permit: TAuthorize,
    open: (url: string) => Promise<boolean> = openVerificationPage,
) {
    const context = await configurationContext(input, authorize);
    await startConfigurationSession(context, permit, open);
    return { ...context.descriptor, opened: true as const };
}
