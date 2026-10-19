import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, writeState, type Workspace } from './state.js';
import { BRIDGE_VERSION, BRIDGE_PROTOCOL, BRIDGE_CAPABILITIES, bridgeBuildId } from './protocol.js';
import { runtimeArtifactTarget,TARGETS } from '../features/runtime-artifacts/model.js';
import { previousDeviceCompletions } from './completions.js';
import { localRagStatus } from '../lib/lancedb.js';
import { workspaceBindingReport } from './workspace-instance.js';
import { recoverWorkspaceIdentity, withWorkspaceIdentityLock } from './workspace-identity-state.js';
export { safeTarget } from './workspace-paths.js';
export { bindProject, projectFolder, projectBindingId, projectInstanceId, workspaceInstanceAt, prepareProjectBinding, commitProjectBinding, adoptLegacyProject } from './workspace-instance.js';
export type { WorkspaceBindingInput, WorkspaceBindingMode, WorkspaceBindingPreparation, WorkspaceBindingResult, WorkspaceFileVerification, VerifyWorkspaceFiles } from './workspace-instance.js';
export { recoverPendingWorkspaceIdentity } from './workspace-identity-state.js';

const exec = promisify(execFile);
/** Диалог не удерживает очередь бесконечно, если окно скрыто или пользователь ушёл. */
async function pick(command: string, args: string[]): Promise<{ stdout: string }> {
    try { return await exec(command, args, { timeout: 120000, maxBuffer: 1024 * 1024 }); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw Object.assign(new Error('Системный диалог выбора папки недоступен. На Linux нужен zenity или kdialog; без графического интерфейса укажите путь командой MCP --projects-root.'), { code: 'ENOENT' });
        }
        throw new Error((error as { killed?: boolean }).killed ? 'Время выбора папки истекло через две минуты. Повторите выбор, когда будете у компьютера.' : 'Выбор папки отменён или недоступен. Повторите его на подключённом компьютере.');
    }
}
/** Локальный native picker выполняется в MCP; сервер никогда не выбирает путь на своём диске. */
export async function chooseRoot(): Promise<Workspace> {
    let chosen: string;
    if (process.platform === 'darwin') {
        chosen = (
            await pick('osascript', [
                '-e',
                'POSIX path of (choose folder with prompt "Выберите общую папку проектов Нейроцентра")',
            ])
        ).stdout.trim();
    } else if (process.platform === 'win32') {
        chosen = (
            await pick('powershell.exe', [
                '-NoProfile',
                '-STA',
                '-Command',
                "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Папка проектов Нейроцентра'; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }",
            ])
        ).stdout.trim();
    } else {
        try {
            chosen = (
                await pick('zenity', [
                    '--file-selection',
                    '--directory',
                    '--title=Папка проектов Нейроцентра',
                ])
            ).stdout.trim();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new Error('Выбор папки отменён.');
            }
            chosen = (
                await pick('kdialog', [
                    '--getexistingdirectory',
                    process.cwd(),
                    '--title',
                    'Папка проектов Нейроцентра',
                ])
            ).stdout.trim();
        }
    }
    if (!chosen) {
        throw new Error('Выбор папки отменён.');
    }
    return setRoot(chosen);
}
export async function setRoot(root: string): Promise<Workspace> {
    const resolved = await fs.realpath(root);
    if (!(await fs.stat(resolved)).isDirectory()) {
        throw new Error('Нужна папка проектов.');
    }
    return withWorkspaceIdentityLock(async () => {
        await recoverWorkspaceIdentity();
        const current = await readState<Workspace>('workspace');
        const workspace = { root: resolved, bindings: current?.bindings || {} };
        await writeState('workspace', workspace);
        return workspace;
    });
}
export async function workspaceReport() {
    const workspace = await readState<Workspace>('workspace');
    let folders:string[]=[];
    let rootError:string|undefined;
    if(workspace?.root){
        try{folders=(await fs.readdir(workspace.root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).slice(0,500).map(entry=>entry.name);}
        catch(error){
            if(!['ENOENT','EACCES','EPERM','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||'')){throw error;}
            rootError='Папка проектов недоступна. Выберите её заново на этом компьютере.';
        }
    }
    return {
        platform: process.platform,
        arch: process.arch,
        runtimeVersion: process.versions.node,
        ...(TARGETS.includes(runtimeArtifactTarget())?{runtimeArtifactTarget:runtimeArtifactTarget()}:{}),
        bridgeVersion: BRIDGE_VERSION,
        buildId: await bridgeBuildId(),
        protocolVersion: BRIDGE_PROTOCOL,
        capabilities: BRIDGE_CAPABILITIES,
        previousDeviceCompletions: await previousDeviceCompletions(),
        ...await localRagStatus(),
        root: workspace?.root || null,
        folders,
        ...(rootError?{rootError}:{}),
        bindings: await Promise.all(Object.entries(workspace?.bindings || {}).map(([projectId, folder]) => workspaceBindingReport(projectId, folder))),
    };
}
