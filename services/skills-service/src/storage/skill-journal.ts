import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeSkillAuditEvents, type ISkillAuditEvent } from '../../../shared/skill-audit.cjs';
import { skillAuditSummary } from './skill-audit';
import { syncSkillDirectory } from './skill-versions';
import {
    isSkillDirectoryChange,
    safeSkillDirectoryPath,
    validateSkillDirectoryChange,
    skillDirectoryState,
    rollbackSkillDirectories,
    type ISkillDirectoryChange,
} from './skill-directory-change';
import {
    assertSkillDurability,
    markSkillDurabilityUncertain,
    SkillDurabilityUncertainException,
    synchronizeSkillCommit,
    uncertainSkillCommits,
    withSkillCommit,
} from './skill-durability';

export const SKILL_JOURNAL_DIRECTORY = '.neurocenter-sync-journal';
export interface ISkillFileChange {
    kind?: never;
    relative: string;
    before: string | null;
    after: string | null;
}
export type TSkillJournalChange = ISkillFileChange | ISkillDirectoryChange;
export interface ISkillJournal {
    version: 1;
    id: string;
    state: 'prepared' | 'committed';
    host: string;
    pid: number;
    changes: TSkillJournalChange[];
    events?: ISkillAuditEvent[];
}
const active = new Set<string>();
const queues = new Map<string, Promise<void>>();
const journalName = /^(?:[a-f0-9]{64}|audit-[a-f0-9-]{36})\.json$/;

export async function readSkillText(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

/** Коллекция сериализуется и между экземплярами хранилища в одном процессе. */
export async function withSkillScope<T>(root: string, scope: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(root) + '\0' + scope;
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    queues.set(key, current);
    await previous;
    try {
        return await work();
    } finally {
        release();
        if (queues.get(key) === current) {
            queues.delete(key);
        }
    }
}

/** Проверка повторяется при восстановлении: журнал не даёт права на произвольный путь. */
async function target(root: string, relative: string, directory = false): Promise<string> {
    if (
        typeof relative !== 'string' ||
        !(directory
            ? safeSkillDirectoryPath(relative)
            : relative.endsWith('.md') &&
              relative
                  .slice(0, -3)
                  .split('/')
                  .every((part) => /^[a-z0-9][a-z0-9_-]*$/.test(part)))
    ) {
        throw new Error('Повреждён путь в журнале скиллов.');
    }
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        try {
            if ((await fs.lstat(current)).isSymbolicLink()) {
                throw new Error('Восстановление скиллов остановлено: путь содержит симлинк.');
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }
    return current;
}

async function replace(file: string, text: string | null, published?: () => void): Promise<void> {
    if (text === null) {
        await fs.rm(file, { force: true });
        await syncSkillDirectory(path.dirname(file));
        return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(temporary, file);
        published?.();
        await syncSkillDirectory(path.dirname(file));
    } finally {
        await fs.rm(temporary, { force: true });
    }
}

export function parseSkillJournal(raw: string, filename?: string): ISkillJournal {
    const journal = JSON.parse(raw) as ISkillJournal;
    if (
        !journal ||
        journal.version !== 1 ||
        !['prepared', 'committed'].includes(journal.state) ||
        typeof journal.host !== 'string' ||
        !Number.isSafeInteger(journal.pid) ||
        journal.pid <= 0 ||
        typeof journal.id !== 'string' ||
        !journal.id ||
        !Array.isArray(journal.changes) ||
        !journal.changes.length ||
        journal.changes.some(
            (change) =>
                !change ||
                typeof change.relative !== 'string' ||
                ![change.before, change.after].every((value) => value === null || typeof value === 'string'),
        )
    ) {
        throw new Error('Повреждён журнал синхронизации скиллов. Сохраните его для ручного восстановления.');
    }
    const directories = journal.changes.filter(isSkillDirectoryChange);
    if (directories.length && journal.changes.length !== 1) {
        throw new Error('Создание папки должно иметь отдельный журнал скиллов.');
    }
    directories.forEach(validateSkillDirectoryChange);
    if (
        journal.changes.some(
            (change) =>
                !isSkillDirectoryChange(change) &&
                (change.kind !== undefined ||
                    !change.relative.endsWith('.md') ||
                    !change.relative
                        .slice(0, -3)
                        .split('/')
                        .every((part) => /^[a-z0-9][a-z0-9_-]*$/.test(part))),
        )
    ) {
        throw new Error('Повреждён путь в журнале скиллов.');
    }
    if (new Set(journal.changes.map((change) => change.relative)).size !== journal.changes.length) {
        throw new Error('Повторяющийся путь в журнале скиллов.');
    }
    const scope = journal.changes[0].relative.split('/')[0];
    if (journal.changes.some((change) => change.relative.split('/')[0] !== scope)) {
        throw new Error('Пакет журнала скиллов должен принадлежать одной коллекции.');
    }
    if (filename !== undefined) {
        const name = path.basename(filename);
        const scopedName = createHash('sha256').update(scope).digest('hex') + '.json';
        const auditName =
            journal.state === 'committed' && /^[a-f0-9-]{36}$/.test(journal.id)
                ? 'audit-' + journal.id + '.json'
                : undefined;
        if (name !== scopedName && name !== auditName) {
            throw new Error('Имя журнала скиллов не соответствует коллекции или UUID.');
        }
    }
    if (journal.events !== undefined) {
        if (!/^[a-f0-9-]{36}$/.test(journal.id) || !Array.isArray(journal.events)) {
            throw new Error('Повреждены события журнала скиллов.');
        }
        const events: ISkillAuditEvent[] = [];
        for (let offset = 0; offset < journal.events.length; offset += 200) {
            events.push(...normalizeSkillAuditEvents({ events: journal.events.slice(offset, offset + 200) }));
        }
        const changed = journal.changes.filter((change) => change.before !== change.after);
        if (
            events.length !== changed.length ||
            new Set(events.map((event) => event.id)).size !== events.length ||
            new Set(events.map((event) => event.resourceId)).size !== events.length ||
            changed.some((change) => {
                const resourceId = isSkillDirectoryChange(change) ? change.relative : change.relative.slice(0, -3);
                const event = events.find((item) => item.resourceId === resourceId);
                if (isSkillDirectoryChange(change)) {
                    return (
                        !event ||
                        event.action !== 'skill.directory.create' ||
                        event.before !== null ||
                        event.after?.directory !== true
                    );
                }
                if (event?.action === 'skill.directory.create') {
                    return true;
                }
                return (
                    !event ||
                    JSON.stringify(event.before) !== JSON.stringify(skillAuditSummary(change.before, resourceId)) ||
                    JSON.stringify(event.after) !== JSON.stringify(skillAuditSummary(change.after, resourceId))
                );
            })
        ) {
            throw new Error('События аудита не соответствуют изменениям журнала скиллов.');
        }
        journal.events = events;
    }
    return journal;
}

export async function readSkillJournal(file: string): Promise<ISkillJournal> {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        if (!(await handle.stat()).isFile()) {
            throw new Error('Журнал скиллов должен быть обычным файлом.');
        }
        return parseSkillJournal(await handle.readFile('utf8'), file);
    } finally {
        await handle.close();
    }
}

export async function skillJournalFiles(root: string): Promise<string[]> {
    const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
    try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Недопустимый каталог журнала скиллов.');
        }
        const entries = await fs.readdir(directory);
        if (entries.some((name) => name.endsWith('.json') && !journalName.test(name))) {
            throw new Error('Неизвестный файл журнала скиллов.');
        }
        return entries
            .filter((name) => journalName.test(name))
            .sort()
            .map((name) => path.join(directory, name));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function writerAlive(journal: ISkillJournal): boolean {
    if (journal.host !== hostname()) {
        return true;
    }
    try {
        process.kill(journal.pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

function assertJournalOwner(file: string, journal: ISkillJournal, own = false): void {
    if (
        !own &&
        (active.has(file) || ((journal.pid !== process.pid || journal.host !== hostname()) && writerAlive(journal)))
    ) {
        throw new Error(
            'Журнал скиллов занят другим процессом. Дождитесь завершения синхронизации или проверьте владельца журнала: ' +
                file,
        );
    }
}

export async function confirmSkillJournal(
    root: string,
    file: string,
    journal: ISkillJournal,
    allowMissing = false,
    releaseGate = true,
): Promise<void> {
    await synchronizeSkillCommit(root, file, journal, (raw) => parseSkillJournal(raw, file), allowMissing, releaseGate);
}

/** Повтор fsync не меняет файл и не обходит владельца ещё не архивированного журнала. */
export async function retrySkillJournalDurability(root: string): Promise<void> {
    for (const record of uncertainSkillCommits(root)) {
        const journal = record.payload as ISkillJournal;
        await withSkillCommit(root, journal, () =>
            withSkillScope(root, journal.changes[0].relative.split('/')[0], async () => {
                const current = uncertainSkillCommits(root).find(
                    (item) =>
                        item.payload.id === journal.id &&
                        item.payload.changes[0].relative.split('/')[0] === journal.changes[0].relative.split('/')[0],
                );
                if (!current) {
                    return;
                }
                if (!path.basename(current.file).startsWith('audit-')) {
                    try {
                        assertJournalOwner(current.file, await readSkillJournal(current.file));
                    } catch (error) {
                        if (
                            (error as NodeJS.ErrnoException).code === 'ENOENT' &&
                            !current.allowMissing &&
                            journal.state === 'committed' &&
                            journal.events?.length
                        ) {
                            await reconcileArchivedJournal(root, current.file, journal);
                            return;
                        }
                        if (!current.allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
                            throw error;
                        }
                    }
                    if (journal.state === 'committed' && journal.events?.length && !current.allowMissing) {
                        let archived = false;
                        try {
                            await fs.lstat(path.join(path.dirname(current.file), 'audit-' + journal.id + '.json'));
                            archived = true;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                                throw error;
                            }
                        }
                        if (archived) {
                            await reconcileArchivedJournal(root, current.file, journal);
                            return;
                        }
                    }
                }
                if (journal.state === 'prepared' && !current.allowMissing) {
                    await recover(root, current.file, false, undefined, journal);
                } else {
                    await confirmSkillJournal(root, current.file, journal, current.allowMissing);
                }
            }),
        );
    }
    assertSkillDurability(root);
}

/** rename мог опубликовать outbox и вернуть EIO: допускается только прежний UUID с прежним payload. */
async function reconcileArchivedJournal(root: string, file: string, journal: ISkillJournal): Promise<void> {
    try {
        assertJournalOwner(file, journal);
        const destination = path.join(path.dirname(file), 'audit-' + journal.id + '.json');
        await confirmSkillJournal(root, destination, journal, false, false);
        try {
            assertJournalOwner(file, await readSkillJournal(file));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        await confirmSkillJournal(root, file, journal, true, false);
        await fs.rm(file, { force: true });
        await confirmSkillJournal(root, file, journal, true);
    } catch (error) {
        // Пока весь переход не доказан, повтор снова проверяет оба пути и владельца scoped marker.
        markSkillDurabilityUncertain(root, file, journal);
        throw error;
    }
}

/** Переименование освобождает коллекцию даже при недоступности каталога аудита. */
export async function archiveSkillJournal(file: string, journal: ISkillJournal, own = false): Promise<void> {
    if (journal.state !== 'committed') {
        throw new Error('Незавершённый журнал нельзя отправить в аудит.');
    }
    const root = path.dirname(path.dirname(file));
    if (!path.basename(file).startsWith('audit-')) {
        assertJournalOwner(file, journal, own);
    }
    await confirmSkillJournal(root, file, journal);
    if (journal.events?.length) {
        const destination = path.join(path.dirname(file), 'audit-' + journal.id + '.json');
        if (file !== destination) {
            let existing: ISkillJournal | undefined;
            try {
                existing = await readSkillJournal(destination);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error;
                }
            }
            if (existing) {
                if (JSON.stringify(existing) !== JSON.stringify(journal)) {
                    throw new Error('UUID журнала аудита скиллов занят другими данными.');
                }
                await fs.rm(file, { force: true });
            } else {
                await fs.rename(file, destination);
            }
        }
        await confirmSkillJournal(root, destination, journal);
    } else {
        await fs.rm(file, { force: true });
        await confirmSkillJournal(root, file, journal, true);
    }
}

async function recover(
    root: string,
    file: string,
    own = false,
    beforeRecover?: (changes: ISkillFileChange[]) => Promise<void>,
    expected?: ISkillJournal,
): Promise<void> {
    let journal: ISkillJournal;
    try {
        journal = await readSkillJournal(file);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    assertJournalOwner(file, journal, own);
    const prior =
        expected ??
        (uncertainSkillCommits(root).find((record) => record.file === file)?.payload as ISkillJournal | undefined);
    if (prior) {
        await confirmSkillJournal(root, file, prior, false, false);
    }
    for (const change of journal.changes) {
        await target(root, change.relative, isSkillDirectoryChange(change));
    }
    if (journal.state === 'committed') {
        await archiveSkillJournal(file, journal, own);
        return;
    }
    const directory = journal.changes.find(isSkillDirectoryChange);
    if (directory) {
        let rollbackStarted = false;
        try {
            await rollbackSkillDirectories(
                directory,
                (relative) => target(root, relative, true),
                async () => {
                    await confirmSkillJournal(root, file, expected ?? journal, false, false);
                    rollbackStarted = true;
                },
            );
            for (const relative of directory.createdDirectories) {
                await syncRollbackParents(root, path.dirname(await target(root, relative, true)));
            }
            await removePreparedJournal(root, file, journal);
        } catch (error) {
            if (!rollbackStarted) {
                throw error;
            }
            throw await uncertainPreparedJournal(root, file, journal);
        }
        return;
    }
    const changes = journal.changes as ISkillFileChange[];
    // Весь набор сверяется до отката: ручная правка блокирует восстановление и сохраняется.
    for (const change of changes) {
        const current = await readSkillText(await target(root, change.relative));
        if (current !== change.before && current !== change.after) {
            throw new Error(
                'После сбоя изменён скилл ' +
                    change.relative +
                    '. Автоматический откат остановлен; резервная копия находится в ' +
                    file,
            );
        }
    }
    // Подтверждение intent не снимает gate до полного устойчивого отката и удаления маркера.
    await confirmSkillJournal(root, file, expected ?? journal, false, false);
    await beforeRecover?.(changes);
    try {
        for (const change of [...changes].reverse()) {
            const destination = await target(root, change.relative);
            const current = await readSkillText(destination);
            if (current !== change.before) {
                if (current !== change.after) {
                    throw new Error('Файл изменился во время отката скиллов: ' + change.relative);
                }
                await replace(destination, change.before);
            }
            if (change.before !== null) {
                const handle = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    if (!(await handle.stat()).isFile() || (await handle.readFile('utf8')) !== change.before) {
                        throw new Error('Файл изменился во время подтверждения отката скиллов.');
                    }
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
            await syncRollbackParents(root, path.dirname(destination));
        }
        await removePreparedJournal(root, file, journal);
    } catch {
        throw await uncertainPreparedJournal(root, file, journal);
    }
}

/** Повтор подтверждает и уже восстановленные головы: предыдущий rename/rmdir мог обогнать fsync. */
async function syncRollbackParents(root: string, directory: string): Promise<void> {
    for (
        let current = directory;
        current === root || current.startsWith(root + path.sep);
        current = path.dirname(current)
    ) {
        try {
            await syncSkillDirectory(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        if (current === root) {
            break;
        }
    }
}

async function uncertainPreparedJournal(
    root: string,
    file: string,
    journal: ISkillJournal,
): Promise<SkillDurabilityUncertainException> {
    let missing = false;
    try {
        await fs.lstat(file);
    } catch (error) {
        missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    const prepared: ISkillJournal = { ...journal, state: 'prepared' };
    return markSkillDurabilityUncertain(root, file, prepared, missing);
}

async function removePreparedJournal(root: string, file: string, journal: ISkillJournal): Promise<void> {
    await fs.rm(file, { force: true });
    await confirmSkillJournal(root, file, journal, true);
}

export async function recoverSkillScope(
    root: string,
    scope: string,
    beforeRecover?: (changes: ISkillFileChange[]) => Promise<void>,
): Promise<void> {
    await recover(
        root,
        path.join(root, SKILL_JOURNAL_DIRECTORY, createHash('sha256').update(scope).digest('hex') + '.json'),
        false,
        beforeRecover,
    );
}

/** При старте откатывает подготовленные пакеты; завершённые передаёт только в outbox. */
export async function recoverSkillJournals(
    root: string,
    beforeRecover?: (changes: ISkillFileChange[]) => Promise<void>,
): Promise<void> {
    for (const file of await skillJournalFiles(root)) {
        try {
            if (/^[a-f0-9]{64}\.json$/.test(path.basename(file))) {
                const journal = await readSkillJournal(file);
                assertJournalOwner(file, journal);
                await withSkillCommit(root, journal, () =>
                    withSkillScope(root, journal.changes[0].relative.split('/')[0], () =>
                        recover(root, file, false, beforeRecover),
                    ),
                );
            } else {
                const journal = await readSkillJournal(file);
                if (journal.state !== 'committed') {
                    throw new Error('Outbox содержит незавершённый журнал скиллов.');
                }
                await withSkillCommit(root, journal, () =>
                    withSkillScope(root, journal.changes[0].relative.split('/')[0], () =>
                        confirmSkillJournal(root, file, journal),
                    ),
                );
            }
        } catch (error) {
            if (!(error instanceof SkillDurabilityUncertainException)) {
                throw error;
            }
        }
    }
}

/** Видимый commit без успешного fsync сохраняется для восстановления и возвращает явную неопределённость. */
export async function withSkillJournal(
    root: string,
    changes: TSkillJournalChange[],
    write: () => Promise<void>,
    beforeRecover?: (changes: ISkillFileChange[]) => Promise<void>,
    events?: ISkillAuditEvent[],
): Promise<void> {
    if (!changes.length) {
        return;
    }
    assertSkillDurability(root);
    const scope = changes[0].relative.split('/')[0];
    if (changes.some((change) => change.relative.split('/')[0] !== scope)) {
        throw new Error('Пакет скиллов должен принадлежать одной коллекции.');
    }
    for (const change of changes) {
        await target(root, change.relative, isSkillDirectoryChange(change));
    }
    const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await syncSkillDirectory(root);
    if ((await fs.lstat(directory)).isSymbolicLink()) {
        throw new Error('Недопустимый каталог журнала скиллов.');
    }
    const file = path.join(directory, createHash('sha256').update(scope).digest('hex') + '.json');
    await recover(root, file, false, beforeRecover);
    const journal: ISkillJournal = {
        version: 1,
        id: randomUUID(),
        state: 'prepared',
        host: hostname(),
        pid: process.pid,
        changes,
        ...(events ? { events } : {}),
    };
    parseSkillJournal(JSON.stringify(journal));
    const temporary = file + '.' + journal.id + '.tmp';
    let prepared = false;
    let committed = false;
    let commitSynchronized = false;
    active.add(file);
    try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(journal), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.link(temporary, file);
        prepared = true;
        await syncSkillDirectory(directory);
        await fs.rm(temporary, { force: true });
        assertSkillDurability(root);
        await write();
        // Не публикуем событие, если сторонняя запись подменила результат операции.
        for (const change of changes) {
            const current = isSkillDirectoryChange(change)
                ? await skillDirectoryState(await target(root, change.relative, true))
                : await readSkillText(await target(root, change.relative));
            if (current !== change.after) {
                throw new Error('Файл изменился во время записи скиллов.');
            }
        }
        assertSkillDurability(root);
        journal.state = 'committed';
        await replace(file, JSON.stringify(journal), () => {
            committed = true;
        });
        commitSynchronized = true;
        await archiveSkillJournal(file, journal, true);
    } catch (error) {
        if (committed) {
            if (!commitSynchronized) {
                throw markSkillDurabilityUncertain(root, file, journal);
            }
            if (error instanceof SkillDurabilityUncertainException) {
                throw error;
            }
            try {
                await archiveSkillJournal(file, journal, true);
            } catch (retry) {
                if (retry instanceof SkillDurabilityUncertainException) {
                    throw retry;
                }
            }
            return;
        }
        if (prepared) {
            // Обе стороны собственного пакета уже зарезервированы; сетевых запросов при откате нет.
            try {
                await recover(root, file, true);
            } catch {
                throw await uncertainPreparedJournal(root, file, journal);
            }
        }
        throw error;
    } finally {
        active.delete(file);
        try {
            await fs.rm(temporary, { force: true });
        } catch (error) {
            if (!committed) {
                // An uncommitted temporary file must not be reported as successfully cleaned up.
                // eslint-disable-next-line no-unsafe-finally
                throw error;
            }
        }
    }
}
