import fs from 'node:fs/promises';
import path from 'node:path';
import { syncDirectory } from '../../bridge/atomic-file.js';
import type { IRoleMcpIdentity } from './api.js';
import { sessionDirectory, retainRoleMcpStdio, type IRoleMcpSessionIntent } from './session-journal.js';
import { closeRoleMcpProcess, findRoleMcpProcess, type IRoleMcpProcessJournal } from './owned-process.js';

export interface IRoleMcpLocalSession {
    home(): Promise<{ path: string; close(): Promise<void> }>;
    process: IRoleMcpProcessJournal;
    settled(): Promise<void>;
}
async function location(identity: IRoleMcpIdentity, intent: IRoleMcpSessionIntent) {
    return path.join(await sessionDirectory(identity, 'system-role-mcp-work'), intent.requestId + '.' + intent.nonce);
}
export async function roleMcpClosurePath(identity: IRoleMcpIdentity, intent: IRoleMcpSessionIntent) {
    return (await location(identity, intent)) + '.closed.json';
}
/** The deterministic private HOME is recorded by the fsynced claim intent before mkdir. */
export async function roleMcpLocalSession(
    identity: IRoleMcpIdentity,
    current: () => IRoleMcpSessionIntent,
    replace: (item: IRoleMcpSessionIntent) => void,
): Promise<IRoleMcpLocalSession> {
    let pending: Promise<void> = Promise.resolve();
    return {
        process: {
            nonce: current().nonce,
            receipt: await roleMcpClosurePath(identity, current()),
            retain(owner) {
                pending = retainRoleMcpStdio(identity, current(), owner).then(replace);
                return pending;
            },
        },
        settled: () => pending,
        async home() {
            const directory = await location(identity, current());
            await fs.mkdir(directory, { mode: 0o700 });
            await syncDirectory(path.dirname(directory));
            return { path: directory, close: () => cleanRoleMcpHome(identity, current()) };
        },
    };
}
export async function cleanRoleMcpHome(identity: IRoleMcpIdentity, intent: IRoleMcpSessionIntent) {
    const directory = await location(identity, intent);
    let info;
    try {
        info = await fs.lstat(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0)
        throw new Error('Рабочая папка MCP изменилась; очистка не подтверждена.');
    await fs.rm(directory, { recursive: true });
    await syncDirectory(path.dirname(directory));
}
/** No request is re-executed: recover only the recorded wrapper and known private HOME. */
export async function cleanRoleMcpSession(identity: IRoleMcpIdentity, intent: IRoleMcpSessionIntent) {
    const receipt = await roleMcpClosurePath(identity, intent),
        owner = intent.stdio ?? (await findRoleMcpProcess(intent.nonce, receipt));
    if (owner) await closeRoleMcpProcess(owner, intent.nonce, receipt);
    await cleanRoleMcpHome(identity, intent);
}
