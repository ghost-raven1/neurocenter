import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectFolder } from './workspace.js';
import { hash, stateDir } from './state.js';
import { recoveryDirectory } from './installation-space.js';

/** Открывает закрытую историю выбранной папки локально; файлы не удаляет и не передаёт серверу. */
export async function openLocalRecoveryFolder(projectId: string): Promise<void> {
    const root = await projectFolder(projectId);
    let directory = path.join(stateDir(),'file-changes',hash(root),'history');
    try { await fs.lstat(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { directory=stateDir(); } else { throw error; } }
    await recoveryDirectory(directory,false);
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    await promisify(execFile)(command,[directory],{timeout:8000,maxBuffer:16*1024,killSignal:'SIGKILL',windowsHide:true});
}
