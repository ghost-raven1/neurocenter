import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export interface UserCliExecutable {
    file: string;
    identity: string;
}
const identity = (value: Awaited<ReturnType<typeof fs.stat>>) =>
    [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

/** A bundled probe/SDK is not evidence of a user's command, including through a PATH symlink. */
function bundled(file: string, roots: readonly string[]): boolean {
    return (
        roots.some((root) => inside(root, file)) ||
        /^opencode-probe(?:\.exe)?$/.test(path.basename(file)) ||
        file.split(path.sep).some((part, index, parts) => part === 'opencode-sdk' && parts[index - 1] === 'bin')
    );
}

/** The worker derives these directories locally; relative PATH entries never borrow a project's cwd. */
export function userOpenCodeDirectories(home: string, search: string): string[] {
    if (search.length > 32768 || search.includes('\0') || !path.isAbsolute(home))
        throw new Error('Некорректное локальное окружение OpenCode.');
    const directories = [
        ...new Set([
            ...search.split(path.delimiter).filter((value) => path.isAbsolute(value)),
            path.join(home, '.opencode', 'bin'),
            path.join(home, '.local', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
        ]),
    ];
    if (directories.length > 256) throw new Error('Слишком много каталогов поиска OpenCode.');
    return directories;
}

/** Resolves a fixed command from the local environment; it never evaluates a shell or aliases. */
export async function findUserOpenCode(
    directories: readonly string[],
    bridgeRoots: readonly string[],
    signal: AbortSignal,
    stopAtBundled = false,
): Promise<UserCliExecutable | undefined> {
    const roots = await Promise.all(
        bridgeRoots.map(async (root) => {
            try {
                return await fs.realpath(root);
            } catch (error) {
                if (missing(error)) return path.resolve(root);
                throw error;
            }
        }),
    );
    let unavailable = false;
    for (const directory of directories) {
        signal.throwIfAborted();
        try {
            const file = await fs.realpath(path.join(directory, 'opencode'));
            if (bundled(file, roots)) {
                if (stopAtBundled) return undefined;
                continue;
            }
            const stat = await fs.stat(file);
            if (!stat.isFile()) {
                unavailable = true;
                continue;
            }
            await fs.access(file, constants.X_OK);
            signal.throwIfAborted();
            return { file, identity: identity(stat) };
        } catch (error) {
            if (signal.aborted) throw signal.reason;
            if (missing(error)) continue;
            if ((error as NodeJS.ErrnoException).code === 'EACCES') {
                unavailable = true;
                continue;
            }
            throw error;
        }
    }
    if (unavailable) throw new Error('Локальный OpenCode недоступен для запуска.');
    return undefined;
}

/** Re-resolve PATH priority and symlinks after each asynchronous authorization barrier. */
export async function assertUserCliCurrent(
    executable: UserCliExecutable,
    directories: readonly string[],
    bridgeRoots: readonly string[],
    signal: AbortSignal,
    stopAtBundled = false,
): Promise<void> {
    const current = await findUserOpenCode(directories, bridgeRoots, signal, stopAtBundled);
    if (!current || current.file !== executable.file || current.identity !== executable.identity)
        throw new Error('OpenCode изменился во время проверки.');
}
