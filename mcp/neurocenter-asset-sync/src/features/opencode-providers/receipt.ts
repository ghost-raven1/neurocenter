import path from 'node:path';
import { hash } from '../../bridge/state.js';
import { journalDirectory, parseJournal } from '../../bridge/installation-journal.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { JOURNAL_BYTES_LIMIT } from '../../bridge/installation-limits.js';
import type { ProviderContext } from './context.js';
export const providerConfig = '.opencode/opencode.jsonc';
export const receiptFile = (id: string) => '.opencode/neurocenter/providers/' + id + '.json';
export const journalKey = (context: ProviderContext) => hash('opencode-provider:' + context.key).slice(0, 24);
export interface ProviderReceipt {
    schemaVersion: 1;
    revision: string;
    schemaDigest: string;
    projectId: string;
    bindingId: string;
    instanceId: string;
    providerId: string;
    entry: Record<string, unknown>;
    credentialFile: string;
    files?: Array<{ relative: string; content: string }>;
    plugin?: string;
    authorization?: { preparationId: string; setupJobId: string };
}
const conflict = () =>
    Object.assign(new Error('Конфликт локального провайдера. Ручные изменения сохранены.'), {
        code: 'OPENCODE_PROVIDER_CONFLICT',
    });
export { conflict };
async function optional(file: string, max: number) {
    try {
        return await readBoundedUtf8(file, max);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
/** The private committed journal, rather than a copyable project receipt, establishes ownership. */
export async function providerProof(
    context: ProviderContext,
): Promise<{ raw: string; receipt: ProviderReceipt } | null> {
    const directory = journalDirectory(context.root),
        key = journalKey(context),
        raw = await optional(path.join(directory, 'assets', key + '.json'), 4096);
    if (raw === null) return null;
    const pointer = JSON.parse(raw) as { action?: string; manifest?: string; recoveryPath?: string };
    if (
        pointer.action !== 'install' ||
        typeof pointer.recoveryPath !== 'string' ||
        path.dirname(pointer.recoveryPath) !== path.join(directory, 'history') ||
        !/^[-a-f0-9]{36}\.json$/.test(path.basename(pointer.recoveryPath))
    )
        throw conflict();
    const history = await optional(pointer.recoveryPath, JOURNAL_BYTES_LIMIT);
    if (!history) throw conflict();
    const journal = parseJournal(history, context.root);
    if (journal.state !== 'committed' || journal.assetKey !== key || journal.manifest !== pointer.manifest)
        throw conflict();
    const stored = journal.changes.find((change) => change.relative === receiptFile(context.descriptor.providerId));
    if (!stored?.after || stored.encoding) throw conflict();
    const receipt = JSON.parse(stored.after) as ProviderReceipt,
        d = context.descriptor;
    if (
        receipt.schemaVersion !== 1 ||
        receipt.providerId !== d.providerId ||
        receipt.projectId !== d.projectId ||
        receipt.instanceId !== d.instanceId ||
        receipt.bindingId !== d.bindingId ||
        receipt.schemaDigest !== journal.manifest ||
        typeof receipt.credentialFile !== 'string' ||
        typeof receipt.entry !== 'object' ||
        !/^[-a-f0-9]{36}$/.test(receipt.revision)
    )
        throw conflict();
    return { raw: stored.after, receipt };
}
