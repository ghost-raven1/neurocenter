import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicText, syncDirectory } from './atomic-file.js';
import { hub, jobContext, readState, stateDir } from './state.js';
import { readBoundedUtf8 } from './read-bounded.js';
import type { PhysicalDirectory, WorkspaceBindingResult, WorkspaceInstanceRegistry } from './workspace-instance.model.js';
import { safeTarget, workspaceDirectory } from './workspace-paths.js';
import { saveCompletion } from './completions.js';
import { assertInstallationSpace } from './installation-space.js';
import { assertMemoryOwnershipHandoffs, assertPreparedMemoryOwnership, finishMemoryOwnershipHandoffs, type MemoryOwnershipHandoff } from '../features/project-learning-memory-sync/workspace-handoff.js';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
export const registryFile = () => path.join(stateDir(), 'workspace-instances.json');

/** Повреждение приватного реестра не превращает чужой marker в новую доверенную привязку. */
export async function readInstanceRegistry(): Promise<WorkspaceInstanceRegistry> {
    const value = await readState<WorkspaceInstanceRegistry>('workspace-instances');
    if (value === undefined) { return { version: 1, instances: {} }; }
    const damaged = () => new Error('Повреждён приватный реестр экземпляров проектов.');
    if (!value || value.version !== 1 || !exactKeys(value, ['version', 'instances']) || !value.instances
        || typeof value.instances !== 'object' || Array.isArray(value.instances) || Object.keys(value.instances).length > 1000) { throw damaged(); }
    for (const [key, entry] of Object.entries(value.instances)) {
        if (!UUID.test(key) || !entry || typeof entry !== 'object' || Array.isArray(entry)
            || !exactKeys(entry, ['instanceId', 'projectId', 'server', 'realpath', 'physical', 'bindingNonce'])
            || entry.instanceId !== key || !UUID.test(entry.bindingNonce) || entry.server !== hub()
            || typeof entry.projectId !== 'string' || !entry.projectId || entry.projectId.length > 128
            || typeof entry.realpath !== 'string' || !path.isAbsolute(entry.realpath)
            || !entry.physical || !exactKeys(entry.physical, ['dev', 'ino', 'birthtimeNs'])
            || ![entry.physical.dev, entry.physical.ino, entry.physical.birthtimeNs].every(part => typeof part === 'string' && decimal.test(part))
            || entry.physical.ino === '0') { throw damaged(); }
    }
    return value;
}

/** Межпроцессная блокировка защищает registry и выбранную папку от двух одновременных rebind. */
export async function withWorkspaceIdentityLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(stateDir(), { recursive: true, mode: 0o700 });
    const target = path.join(stateDir(), 'workspace-identity.lock');
    const token = randomUUID();
    const raw = JSON.stringify({ pid: process.pid, token });
    const acquire = () => fs.writeFile(target, raw, { flag: 'wx', mode: 0o600 });
    try { await acquire(); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
        let previous: { pid: number; token: string };
        let previousRaw: string;
        try {
            previousRaw = await readBoundedUtf8(target, 1024);
            previous = JSON.parse(previousRaw) as typeof previous;
            if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || !UUID.test(previous.token)) { throw new Error(); }
        } catch { throw new Error('Привязка уже изменяется или её блокировка повреждена.'); }
        try { process.kill(previous.pid, 0); }
        catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ESRCH') { previous.pid = 0; } }
        if (previous.pid !== 0) { throw new Error('Привязка уже изменяется. Повторите после завершения операции.'); }
        const guard = path.join(stateDir(), 'workspace-identity-recovery.lock');
        await fs.writeFile(guard, raw, { flag: 'wx', mode: 0o600 });
        try {
            if (await readBoundedUtf8(target, 1024) !== previousRaw) { throw new Error('Блокировка привязки изменилась.'); }
            await fs.rm(target); await acquire();
        } finally { await fs.rm(guard); }
    }
    try { return await action(); }
    finally {
        if (await readBoundedUtf8(target, 1024) === raw) { await fs.rm(target); }
    }
}

interface IdentityChange { file: string; before: string | null; after: string; }
interface IdentityJournal {
    version: 1;
    state: 'prepared' | 'committed';
    target: { realpath: string; physical: PhysicalDirectory };
    changes: IdentityChange[];
    result: WorkspaceBindingResult;
    job?: { id: string; lease: string; deviceId?: string };
    memoryOwnership?: MemoryOwnershipHandoff[];
}
const pendingFile = () => path.join(stateDir(), 'workspace-identity-pending.json');
const committedFailure = (cause: unknown): Error => Object.assign(new Error('Привязка сохранена; подтверждение требует восстановления.'), { localChangesCommitted: true, cause });
export async function optionalText(file: string, limit = 1048576): Promise<string | null> {
    try { return await readBoundedUtf8(file, limit); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error; }
}

/** Только явная запись восстанавливает прерванный commit; обычный heartbeat ничего не меняет. */
export async function recoverWorkspaceIdentity(failOnRolledBackJob = false): Promise<WorkspaceBindingResult | undefined> {
    const raw = await optionalText(pendingFile(), 8 * 1048576);
    if (raw === null) { return; }
    let journal: IdentityJournal;
    try {
        journal = JSON.parse(raw) as IdentityJournal;
        if (journal.version !== 1 || !['prepared', 'committed'].includes(journal.state) || !journal.target
            || !exactKeys(journal, ['version', 'state', 'target', 'changes', 'result', ...(journal.job ? ['job'] : []), ...(journal.memoryOwnership ? ['memoryOwnership'] : [])])
            || !journal.result || typeof journal.result.projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(journal.result.projectId)
            || typeof journal.result.folderName !== 'string' || !journal.result.folderName || /[\x00-\x1f/\\:]/.test(journal.result.folderName)
            || ['.', '..'].includes(journal.result.folderName)
            || !exactKeys(journal.result, ['projectId', 'folderName', 'mode', 'preparation', 'instanceId', 'bindingId', ...(journal.result.previousBindingId ? ['previousBindingId'] : [])])
            || !['new', 'new-copy', 'adopt-legacy', 'transfer', 'resume'].includes(journal.result.mode)
            || !/^[a-f0-9]{64}$/.test(journal.result.preparation) || !UUID.test(journal.result.instanceId)
            || !/^[a-f0-9]{64}$/.test(journal.result.bindingId) || Buffer.byteLength(JSON.stringify(journal.result)) > 10000
            || journal.result.previousBindingId !== undefined && !/^[a-f0-9]{64}$/.test(journal.result.previousBindingId)
            || journal.job !== undefined && (!exactKeys(journal.job, ['id', 'lease', ...(journal.job.deviceId ? ['deviceId'] : [])])
                || !UUID.test(journal.job.id) || !UUID.test(journal.job.lease) || journal.job.deviceId !== undefined && !UUID.test(journal.job.deviceId))
            || !Array.isArray(journal.changes) || journal.changes.length !== 3
            || journal.changes.some(change => !change || typeof change.file !== 'string' || !path.isAbsolute(change.file)
                || typeof change.after !== 'string' || change.before !== null && typeof change.before !== 'string')
            || journal.changes[1]!.file !== registryFile() || journal.changes[2]!.file !== path.join(stateDir(), 'workspace.json')
            || path.basename(journal.changes[0]!.file) !== 'neurocenter.json' || path.basename(path.dirname(journal.changes[0]!.file)) !== '.opencode') { throw new Error(); }
        if (journal.memoryOwnership !== undefined) { assertMemoryOwnershipHandoffs(journal.memoryOwnership,journal.result); }
    } catch { throw new Error('Повреждён журнал привязки. Автоматическое восстановление остановлено.'); }
    if (JSON.stringify(await workspaceDirectory(journal.target.realpath)) !== JSON.stringify(journal.target)
        || await safeTarget(journal.target.realpath, '.opencode/neurocenter.json') !== journal.changes[0]!.file) {
        throw new Error('Каталог прерванной привязки был заменён. Автоматическое восстановление остановлено.');
    }
    for (const change of journal.changes) {
        const current = await optionalText(change.file);
        if (journal.state === 'committed' ? current !== change.after : current !== change.before && current !== change.after) {
            throw new Error('Файлы привязки изменены после остановки. Восстановление требует проверки.');
        }
    }
    if (journal.state === 'committed') {
        try {
            await finishMemoryOwnershipHandoffs(journal.memoryOwnership ?? []);
            await saveWorkspaceBindingCompletion(journal.result, journal.job);
            await fs.rm(pendingFile()); await syncDirectory(stateDir());
            return journal.result;
        } catch (error) { throw committedFailure(error); }
    }
    await assertInstallationSpace(journal.target.realpath, Buffer.byteLength(raw), [{ relative: '.opencode/neurocenter.json',
        before: journal.changes[0]!.before, after: journal.changes[0]!.after }]);
    for (const change of [...journal.changes].reverse()) {
        if (await optionalText(change.file) === change.before) { continue; }
        if (change.before === null) { await fs.rm(change.file); await syncDirectory(path.dirname(change.file)); }
        else { await atomicText(change.file, change.before, 0o600); }
    }
    if (journal.job) {
        await saveCompletion({ ...journal.job, state: 'failed', message: 'Привязка прервана и восстановлена.', result: {} });
    }
    await fs.rm(pendingFile()); await syncDirectory(stateDir());
    if (failOnRolledBackJob && journal.job?.id === jobContext.getStore()?.id && journal.job) {
        throw new Error('Привязка прервана и восстановлена.');
    }
}

/** Три записи фиксируются с приватным undo-журналом; неизвестные сторонние правки не затираются. */
export async function commitWorkspaceIdentity(changes: IdentityChange[], target: IdentityJournal['target'], result: WorkspaceBindingResult, memoryOwnership: MemoryOwnershipHandoff[] = []): Promise<void> {
    const assertTarget = async () => {
        if (JSON.stringify(await workspaceDirectory(target.realpath)) !== JSON.stringify(target)
            || await safeTarget(target.realpath, '.opencode/neurocenter.json') !== changes[0]?.file) {
            throw new Error('Физическая папка изменилась при сохранении привязки.');
        }
    };
    await assertTarget();
    if (await optionalText(pendingFile(), 8 * 1048576) !== null) { throw new Error('Незавершённая привязка требует восстановления.'); }
    for (const change of changes) {
        if (await optionalText(change.file) !== change.before) { throw new Error('Привязка изменилась до сохранения.'); }
    }
    assertMemoryOwnershipHandoffs(memoryOwnership,result);
    await assertPreparedMemoryOwnership(memoryOwnership);
    const journal: IdentityJournal = { version: 1, state: 'prepared', target, changes, result,
        ...(memoryOwnership.length ? {memoryOwnership} : {}),
        ...(jobContext.getStore() ? { job: jobContext.getStore() } : {}) };
    const encoded = JSON.stringify(journal);
    if (Buffer.byteLength(encoded) > 8 * 1048576) { throw new Error('Журнал привязки превышает лимит 8 МиБ.'); }
    await assertInstallationSpace(target.realpath, Buffer.byteLength(encoded), [{ relative: '.opencode/neurocenter.json', before: changes[0]!.before, after: changes[0]!.after }]);
    await atomicText(pendingFile(), encoded, 0o600);
    try {
        for (const change of changes) {
            await assertTarget();
            if (await optionalText(change.file) !== change.before) { throw new Error('Привязка изменилась при сохранении.'); }
            await atomicText(change.file, change.after, 0o600);
        }
        await assertPreparedMemoryOwnership(memoryOwnership);
        journal.state = 'committed';
        await atomicText(pendingFile(), JSON.stringify(journal), 0o600);
    } catch (error) {
        await recoverWorkspaceIdentity(); throw error;
    }
    // Не откатываем завершённую identity, если диск временно не принял durable completion.
    try {
        await finishMemoryOwnershipHandoffs(memoryOwnership);
        await saveWorkspaceBindingCompletion(result, journal.job);
        await fs.rm(pendingFile()); await syncDirectory(stateDir());
    } catch (error) { throw committedFailure(error); }
}

/** Одинаковый результат фиксируется до сетевой доставки и не содержит локальных путей. */
export async function saveWorkspaceBindingCompletion(result: WorkspaceBindingResult, job = jobContext.getStore()): Promise<void> {
    if (job) {
        await saveCompletion({ ...job, state: 'succeeded', message: 'Папка проекта подтверждена. Локальная идентичность сохранена.', result: { ...result } });
    }
}

/** Worker явно восстанавливает журнал перед доставкой подтверждений; heartbeat остаётся чтением. */
export async function recoverPendingWorkspaceIdentity(): Promise<WorkspaceBindingResult | undefined> {
    return withWorkspaceIdentityLock(recoverWorkspaceIdentity);
}
