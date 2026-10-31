import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir } from '../../bridge/state.js';
import { readBoundedSnapshot } from '../../bridge/read-bounded.js';
import { enforcePrivateWindowsAcl, assertPrivateWindowsAcl } from '../local-configuration/private-store.js';
const unsafe = () => new Error('Небезопасное приватное хранилище ключа провайдера.');
async function directory() {
    const parent = stateDir();
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const before = await fs.lstat(parent);
    if (!before.isDirectory() || before.isSymbolicLink()) throw unsafe();
    const root = path.join(await fs.realpath(parent), 'opencode-provider-keys');
    try {
        await fs.mkdir(root, { mode: 0o700 });
        await enforcePrivateWindowsAcl(root, true);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(root);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
        throw unsafe();
    await assertPrivateWindowsAcl(root);
    return { root, stat };
}
/** Immutable raw bytes work with OpenCode {file:...}; JSON wrappers would alter the API key. */
export async function createProviderCredential(value: unknown): Promise<string> {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x20\x7f{}]/.test(value))
        throw new Error('Введите корректный ключ локально.');
    const { root, stat } = await directory(),
        file = path.join(root, randomUUID() + '.key');
    if (/[{}]/.test(file)) throw unsafe();
    let handle;
    let count = 0,
        bytes = Buffer.byteLength(value);
    for await (const item of await fs.opendir(root)) {
        if (++count >= 256) throw new Error('Превышен лимит локальных ключей провайдеров.');
        const entry = await fs.lstat(path.join(root, item.name));
        if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw unsafe();
        bytes += entry.size;
        if (bytes > 2 * 1024 * 1024) throw unsafe();
    }
    try {
        handle = await fs.open(
            file,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
        );
        await handle.writeFile(value);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await enforcePrivateWindowsAcl(file, false);
        const after = await fs.lstat(root);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink()) throw unsafe();
        return file;
    } catch (error) {
        await fs.rm(file, { force: true }).catch(() => {});
        throw error;
    } finally {
        await handle?.close();
    }
}
/** Presence checks never return or fingerprint the secret to a status/report. */
export async function providerCredentialPresent(file: string, expected?: string): Promise<boolean> {
    const { root } = await directory();
    if (path.dirname(file) !== root || !/^[-a-f0-9]{36}\.key$/.test(path.basename(file))) throw unsafe();
    try {
        const stat = await fs.lstat(file);
        if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
        )
            throw unsafe();
        await assertPrivateWindowsAcl(file);
        const { bytes } = await readBoundedSnapshot(file, 8192);
        return (
            bytes.length > 0 &&
            !/[\x00-\x20\x7f{}]/.test(bytes.toString('utf8')) &&
            (expected === undefined || bytes.equals(Buffer.from(expected)))
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
}
