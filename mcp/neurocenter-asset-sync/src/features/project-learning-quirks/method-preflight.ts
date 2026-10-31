import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readBoundedSnapshot } from '../../bridge/read-bounded.js';
import { safeTarget, workspaceDirectory } from '../../bridge/workspace-paths.js';
import { readQuirksSource } from './source.js';

export interface MethodQuirkStorage {
    status: 'absent' | 'verified';
    fileSha256?: string;
    assertCurrent: () => Promise<void>;
}
const invalid = () =>
    Object.assign(
        new Error(
            'Хранилище Quirk не прошло проверку. Исходные данные сохранены; проверьте хранилище перед запуском методики.',
        ),
        { code: 'QUIRK_STORAGE_INVALID' },
    );
const configPaths = ['opencode-rag.json', '.opencode/opencode-rag.json', '.opencode/rag.json'];

async function configurationPin(root: string): Promise<string> {
    for (const relative of configPaths) {
        const file = await safeTarget(root, relative);
        try {
            await fs.lstat(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
        }
        const value = await readBoundedSnapshot(file, 256 * 1024);
        return JSON.stringify([relative, value.fingerprint, createHash('sha256').update(value.bytes).digest('hex')]);
    }
    return 'absent';
}

/** Validate existing knowledge before OpenCode can load a plugin; never open/recover/reconcile its database. */
export async function assertMethodQuirkStorage(
    root: string,
    authorize: () => Promise<unknown>,
): Promise<MethodQuirkStorage> {
    const observe = async () => {
        const directory = await workspaceDirectory(root),
            configuration = await configurationPin(root);
        try {
            const source = await readQuirksSource(root, async () => {});
            if ((await configurationPin(root)) !== configuration) throw invalid();
            return { status: 'verified' as const, source, directory, configuration, missing: '' };
        } catch (error) {
            const missing = (error as NodeJS.ErrnoException).path;
            if (
                (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
                typeof missing !== 'string' ||
                path.basename(missing) !== 'quirks.jsonl'
            )
                throw error;
            const relative = path.relative(root, missing);
            if (
                !relative ||
                relative === '..' ||
                relative.startsWith('..' + path.sep) ||
                path.isAbsolute(relative) ||
                (await configurationPin(root)) !== configuration
            )
                throw invalid();
            return { status: 'absent' as const, source: undefined, directory, configuration, missing };
        }
    };
    await authorize();
    let initial: Awaited<ReturnType<typeof observe>>;
    try {
        initial = await observe();
    } catch {
        throw invalid();
    }
    await authorize();
    let sourceRequired = initial.status === 'verified';
    const assertCurrent = async (): Promise<void> => {
        await authorize();
        try {
            // Plugins may append/create healthy records. Revalidate their complete stable source,
            // while the physical project and configuration keep its resolved location pinned.
            const current = await observe();
            if (
                current.configuration !== initial.configuration ||
                JSON.stringify(current.directory) !== JSON.stringify(initial.directory) ||
                (sourceRequired && current.status === 'absent')
            )
                throw invalid();
            if (current.status === 'verified') sourceRequired = true;
        } catch {
            throw invalid();
        }
        await authorize();
    };
    await assertCurrent();
    return {
        status: initial.status,
        ...(initial.source ? { fileSha256: initial.source.fileSha256 } : {}),
        assertCurrent,
    };
}
