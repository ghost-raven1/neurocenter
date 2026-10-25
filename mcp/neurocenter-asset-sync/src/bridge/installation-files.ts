import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, stateDir, jobContext, readState, type Workspace } from './state.js';
import { projectFolder, safeTarget } from './workspace.js';
import { saveCompletion } from './completions.js';
import { atomicText, syncDirectory } from './atomic-file.js';
import { readBoundedBytes, readBoundedSnapshot, readBoundedUtf8 } from './read-bounded.js';
import { FILE_BYTES_LIMIT, JOURNAL_BYTES_LIMIT, LOCK_BYTES_LIMIT, installationReadLimit } from './installation-limits.js';
import { encodeJournal, journalDirectory, parseJournal, validateChanges, type FileChange, type ChangeIdentity, type Journal } from './installation-journal.js';
import { assertInstallationSpace, recoveryDirectory, withRecoveryBudget } from './installation-space.js';
import { indexLocalRecovery, recoveryIndexRecord } from './local-recovery-index.js';
import { PROJECT_AGENTS_NOTE } from '../features/project-agents/contract.js';
export type { FileChange, ChangeIdentity } from './installation-journal.js';

export const CONFIG_PATHS = [
    '.opencode/opencode.jsonc',
    '.opencode/opencode.json',
    'opencode.jsonc',
    'opencode.json',
];
export async function readText(file: string, encoding: 'utf8' | 'base64' = 'utf8', maximum = FILE_BYTES_LIMIT): Promise<string | null> {
    try {
        return encoding === 'base64' ? (await readBoundedBytes(file, maximum)).toString('base64') : await readBoundedUtf8(file, maximum);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
async function snapshot(root: string, change: FileChange): Promise<{ text: string; fingerprint: string; mode: number } | null> {
    const target = await safeTarget(root, change.relative);
    let current;
    try { current = await readBoundedSnapshot(target, installationReadLimit(change.relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error; }
    await safeTarget(root, change.relative);
    const text = current.bytes.toString(change.encoding ?? 'utf8');
    if (!change.encoding && !Buffer.from(text).equals(current.bytes)) { throw new Error('Некорректное кодирование локального файла.'); }
    return { text, fingerprint: current.fingerprint, mode: current.mode };
}
async function publishPending(file: string, text: string): Promise<void> {
    await recoveryDirectory(path.dirname(file));
    const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.pending');
    try {
        await atomicText(temporary, text, 0o600);
        // link публикует журнал исключительно: существующий pending не перезаписывается.
        await fs.link(temporary, file);
        await syncDirectory(path.dirname(file));
    } finally { await fs.rm(temporary, { force: true }); }
}
async function replace(
    file: string,
    text: string | null,
    privateFile = false,
    encoding: 'utf8' | 'base64' = 'utf8',
    expectedFingerprint?: string | null,
    absentMode = 0o600,
): Promise<void> {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return null; } throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > (privateFile ? JOURNAL_BYTES_LIMIT : 4 * FILE_BYTES_LIMIT))) {
        throw new Error('Файл локальной записи стал небезопасным или превысил допустимый размер.');
    }
    const verify = async () => {
        if (expectedFingerprint === undefined) { return; }
        const current = await readBoundedSnapshot(file, 4 * FILE_BYTES_LIMIT).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') { return null; } throw error;
        });
        if ((current?.fingerprint ?? null) !== expectedFingerprint) { throw new Error('Файл изменился перед фиксацией: ' + path.basename(file)); }
    };
    if (text === null) {
        await verify();
        await fs.rm(file, { force: true });
        await syncDirectory(path.dirname(file));
        return;
    }
    if (privateFile) { await recoveryDirectory(path.dirname(file)); }
    else { await fs.mkdir(path.dirname(file), { recursive: true }); }
    const mode = privateFile
        ? 0o600
        : stat ? stat.mode & 0o777 : absentMode;
    if (expectedFingerprint === undefined) { await atomicText(file, text, mode, encoding); return; }
    const temporary = path.join(path.dirname(file), '.' + randomUUID() + '.staged');
    try {
        await atomicText(temporary, text, mode, encoding);
        await verify();
        if (expectedFingerprint === null) { await fs.link(temporary, file); await fs.unlink(temporary); }
        else { await fs.rename(temporary, file); }
        await syncDirectory(path.dirname(file));
    } finally { await fs.rm(temporary, { force: true }); }
}
async function archive(journal: Journal): Promise<string> {
    const directory = journalDirectory(journal.root);
    const destination = path.join(directory, 'history', journal.id + '.json');
    await recoveryDirectory(path.dirname(destination));
    const pending = path.join(directory, 'pending.json');
    const text = await readText(pending, 'utf8', JOURNAL_BYTES_LIMIT);
    if (text === null || encodeJournal(parseJournal(text, journal.root)) !== encodeJournal(journal)) { throw new Error('Журнал изменился перед архивированием.'); }
    if (journal.state === 'committed') {
        await replace(
            path.join(directory, 'assets', journal.assetKey + '.json'),
            JSON.stringify({
                action: journal.action,
                manifest: journal.manifest,
                recoveryPath: destination,
            }),
            true,
        );
    }
    if (journal.job && journal.result) {
        const succeeded = journal.state === 'committed';
        const agents = journal.result.readiness==='configured'&&journal.result.note===PROJECT_AGENTS_NOTE;
        await saveCompletion({
            ...journal.job,
            state: succeeded ? 'succeeded' : 'failed',
            message: succeeded&&agents?PROJECT_AGENTS_NOTE:succeeded
                ? journal.action === 'install' ? 'Файлы установлены; запуск инструмента ещё не проверен.' : 'Файлы и подключение удалены; OpenCode нужно перезапустить.'
                : 'Прерванная операция восстановлена: незавершённые изменения отменены.',
            result: !succeeded&&agents?{}:{ ...journal.result, recoveryPath: destination, ...(!succeeded ? { rolledBack: true } : {}) },
        });
    }
    try { await fs.link(pending, destination); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readText(destination, 'utf8', JOURNAL_BYTES_LIMIT) !== text) { throw error; }
    }
    await indexLocalRecovery(journal);
    await fs.unlink(pending);
    await syncDirectory(path.dirname(destination));
    await syncDirectory(directory);
    return destination;
}
async function rollback(journal: Journal): Promise<void> {
    const observed = new Map<string, string | null>();
    // Проверяем весь набор до отката: посторонние правки не заменяются резервной копией.
    for (const change of journal.changes) {
        const current = await snapshot(journal.root, change);
        observed.set(change.relative, current?.fingerprint ?? null);
        if ((current?.text ?? null) !== change.before && (current?.text ?? null) !== change.after) {
            throw new Error(
                'После прерывания изменён файл ' +
                    change.relative +
                    '. Автоматический откат остановлен; резервная копия: ' +
                    journalDirectory(journal.root),
            );
        }
    }
    for (const change of [...journal.changes].reverse()) {
        const target = await safeTarget(journal.root, change.relative);
        const current = await snapshot(journal.root, change);
        if ((current?.fingerprint ?? null) !== observed.get(change.relative)) { throw new Error('Файл изменился во время отката: ' + change.relative); }
        if ((current?.text ?? null) !== change.before) {
            if ((current?.text ?? null) !== change.after) {
                throw new Error(
                    'Файл изменился во время отката: ' + change.relative,
                );
            }
            // Существующий файл сохраняет ручной chmod; старый журнал без режима создаёт закрытый файл.
            await replace(target, change.before, false, change.encoding, current?.fingerprint ?? null, change.beforeMode);
        }
    }
    journal.state = 'rolled-back';
    await replace(
        path.join(journalDirectory(journal.root), 'pending.json'),
        encodeJournal(journal),
        true,
    );
    await archive(journal);
}
async function recover(root: string): Promise<void> {
    try { await recoveryDirectory(journalDirectory(root), false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    const pending = await readText(
        path.join(journalDirectory(root), 'pending.json'), 'utf8', JOURNAL_BYTES_LIMIT,
    );
    if (pending === null) {
        return;
    }
    const journal = parseJournal(pending, root);
    await withRecoveryBudget(root, Buffer.byteLength(pending), journal.changes, false, async () => {
        if (await readText(path.join(journalDirectory(root), 'pending.json'), 'utf8', JOURNAL_BYTES_LIMIT) !== pending) { throw new Error('Журнал изменился перед восстановлением.'); }
        if (journal.state === 'prepared') { await rollback(journal); }
        else { await archive(journal); }
    });
}

/** Локальный lock охватывает проверку, запись и восстановление после остановки процесса. */
export async function withProjectFiles<T>(
    projectId: string,
    action: (root: string) => Promise<T>,
): Promise<T> {
    return withProjectFilesAt(await projectFolder(projectId), action);
}

/** Wizard удерживает тот же lock для явно проверенной исходной или целевой папки. */
export async function withProjectFilesAt<T>(projectRoot: string, action: (root: string) => Promise<T>): Promise<T> {
    const root = await fs.realpath(projectRoot);
    await assertInstallationSpace(root);
    const target = await safeTarget(root, '.opencode/neurocenter/files.lock');
    await fs.mkdir(path.dirname(target), { recursive: true });
    const token = randomUUID();
    const acquire = () =>
        fs.writeFile(target, JSON.stringify({ pid: process.pid, token }), {
            flag: 'wx',
            mode: 0o600,
        });
    try {
        await acquire();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw error;
        }
        let previous: { pid: number; token: string };
        try {
            previous = JSON.parse(
                await readBoundedUtf8(target, LOCK_BYTES_LIMIT),
            ) as typeof previous;
        } catch {
            throw new Error(
                'Локальная установка уже выполняется или lock повреждён: ' +
                    target,
            );
        }
        if (!Number.isInteger(previous.pid) || previous.pid < 1) {
            throw new Error('Повреждён lock установки: ' + target);
        }
        let alive = true;
        try {
            process.kill(previous.pid, 0);
        } catch (reason) {
            if ((reason as NodeJS.ErrnoException).code === 'ESRCH') {
                alive = false;
            }
        }
        if (alive) {
            throw new Error(
                'В этом проекте уже выполняется локальная установка. Повторите после её завершения.',
            );
        }
        const guard = path.join(journalDirectory(root), 'recovery.lock');
        await recoveryDirectory(path.dirname(guard));
        try {
            await fs.writeFile(
                guard,
                JSON.stringify({ pid: process.pid, token }),
                { flag: 'wx', mode: 0o600 },
            );
        } catch (reason) {
            if ((reason as NodeJS.ErrnoException).code === 'EEXIST') {
                throw new Error(
                    'Восстановление установки уже начато. Если процесс прерван, проверьте резервную копию и recovery.lock: ' +
                        path.dirname(guard),
                );
            }
            throw reason;
        }
        try {
            // Только один процесс вправе убрать именно эту оставленную блокировку.
            if ((await readText(target, 'utf8', LOCK_BYTES_LIMIT)) !== JSON.stringify(previous)) {
                throw new Error(
                    'Состояние локальной установки изменилось. Повторите запрос.',
                );
            }
            await fs.rm(target);
            await acquire();
        } finally {
            await fs.rm(guard, { force: true });
        }
    }
    try {
        await recover(root);
        return await action(root);
    } finally {
        const current = await readText(target, 'utf8', LOCK_BYTES_LIMIT);
        if (current && JSON.parse(current).token === token) {
            await fs.rm(target, { force: true });
        }
    }
}

/** Снимки остаются в личной папке MCP с правами 0600; в репозиторий проекта они не записываются. */
export async function commitChanges(
    root: string,
    changes: FileChange[],
    identity: ChangeIdentity,
    options: { verifySnapshot?: () => Promise<void> } = {},
): Promise<string> {
    validateChanges(changes);
    for (const change of changes) { await safeTarget(root, change.relative); }
    const observed = new Map<string, string | null>();
    const preparedChanges: FileChange[] = [];
    // Права фиксируются до кодирования и расчёта бюджета, в том числе для вызовов без InstallationPlan.
    for (const change of changes) {
        const current = await snapshot(root, change);
        if ((current?.text ?? null) !== change.before
            || change.beforeFingerprint !== undefined && change.beforeFingerprint !== (current?.fingerprint ?? null)
            || change.beforeMode !== undefined && change.beforeMode !== current?.mode) {
            throw new Error('Файл изменился во время операции; автоматический откат остановлен: ' + change.relative);
        }
        observed.set(change.relative, current?.fingerprint ?? null);
        preparedChanges.push({ ...change, ...(current ? { beforeMode: current.mode } : {}) });
    }
    const journal: Journal = {
        ...identity,
        version: 1,
        root,
        id: randomUUID(),
        state: 'prepared',
        changes: preparedChanges,
        ...(jobContext.getStore() && identity.result ? { job: jobContext.getStore() } : {}),
    };
    if (journal.job && journal.result && Buffer.byteLength(JSON.stringify({ ...journal.result,
        recoveryPath: path.join(journalDirectory(root), 'history', journal.id + '.json'), rolledBack: true })) > 10000) {
        throw new Error('Результат набора слишком велик для надёжного подтверждения. Файлы не изменены.');
    }
    const encoded = encodeJournal(journal);
    const indexBytes = journal.recovery ? Buffer.byteLength(JSON.stringify(recoveryIndexRecord({...journal,state:'committed'}))) : 0;
    const reservedBytes = indexBytes + Math.max(...(['prepared', 'committed', 'rolled-back'] as const).map(state => Buffer.byteLength(encodeJournal({ ...journal, state }))));
    return withRecoveryBudget(root, reservedBytes, journal.changes, true, async () => {
        await options.verifySnapshot?.();
        for (const change of journal.changes) {
            const current = await snapshot(root, change);
            if ((current?.text ?? null) !== change.before || (current?.fingerprint ?? null) !== observed.get(change.relative)) {
                throw new Error('Файл изменился во время операции; автоматический откат остановлен: ' + change.relative);
            }
        }
        const pending = path.join(journalDirectory(root), 'pending.json');
        if ((await readText(pending, 'utf8', JOURNAL_BYTES_LIMIT)) !== null) { throw new Error('Предыдущая запись требует восстановления.'); }
        await publishPending(pending, encoded);
        try {
            for (const change of journal.changes) {
                const target = await safeTarget(root, change.relative);
                const current = await snapshot(root, change);
                if ((current?.text ?? null) !== change.before || (current?.fingerprint ?? null) !== observed.get(change.relative)) { throw new Error('Файл изменился во время операции: ' + change.relative); }
                await replace(target, change.after, false, change.encoding, current?.fingerprint ?? null);
            }
        } catch (error) { await rollback(journal); throw error; }
        journal.state = 'committed';
        await replace(pending, encodeJournal(journal), true);
        try { return await archive(journal); }
        catch (error) { throw Object.assign(new Error('Файлы зафиксированы; подтверждение требует восстановления.'), { localChangesCommitted: true, cause: error }); }
    });
}

/** После перезапуска завершаем только собственные журналы с известным заданием и неизменной привязкой. */
export async function recoverFileJobs(): Promise<void> {
    const workspace = await readState<Workspace>('workspace');
    const parent = path.join(stateDir(), 'file-changes');
    try { await recoveryDirectory(parent, false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    const folders = await fs.readdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return []; }
        throw error;
    });
    for (const folder of folders.filter(folder => /^[a-f0-9]{64}$/.test(folder))) {
        const directory = path.join(parent, folder);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) { throw new Error('Повреждена папка локального журнала.'); }
        const raw = await readText(path.join(directory, 'pending.json'), 'utf8', JOURNAL_BYTES_LIMIT);
        if (!raw) { continue; }
        let candidate: Journal;
        try {
            const parsed = JSON.parse(raw) as Journal | null;
            if (!parsed || typeof parsed.root !== 'string') { throw new Error(); }
            candidate = parseJournal(raw, parsed.root);
        } catch { throw new Error('Повреждён локальный журнал восстановления.'); }
        if (!candidate.job) { continue; }
        const projectId = candidate.result?.projectId;
        if (typeof projectId !== 'string' || workspace?.bindings[projectId] !== candidate.root || hash(candidate.root) !== folder) {
            throw new Error('Для восстановления установки проверьте привязку исходной папки проекта.');
        }
        await withProjectFiles(projectId, async () => undefined);
    }
}
export async function removalCompleted(
    root: string,
    assetKey: string,
    manifest: string,
): Promise<{ recoveryPath: string } | undefined> {
    if (!/^[a-f0-9]{24}$/.test(assetKey)) { throw new Error('Некорректный ключ локального инструмента.'); }
    try { await recoveryDirectory(path.join(journalDirectory(root), 'assets'), false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
    const text = await readText(
        path.join(journalDirectory(root), 'assets', assetKey + '.json'), 'utf8', LOCK_BYTES_LIMIT,
    );
    if (text === null) {
        return undefined;
    }
    const result = JSON.parse(text) as {
        action: string;
        manifest: string;
        recoveryPath: string;
    };
    if (!result || !['install', 'uninstall'].includes(result.action) || !/^[a-f0-9]{64}$/.test(result.manifest)
        || typeof result.recoveryPath !== 'string' || path.dirname(result.recoveryPath) !== path.join(journalDirectory(root), 'history')
        || !/^[-a-f0-9]{36}\.json$/.test(path.basename(result.recoveryPath))) { throw new Error('Повреждена запись последней локальной операции.'); }
    return result.action === 'uninstall' && result.manifest === manifest
        ? { recoveryPath: result.recoveryPath }
        : undefined;
}
