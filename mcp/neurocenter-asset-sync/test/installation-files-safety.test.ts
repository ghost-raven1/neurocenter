import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitChanges, readText, withProjectFiles } from '../src/bridge/installation-files.js';
import { journalDirectory } from '../src/bridge/installation-journal.js';
import { InstallationPlan } from '../src/bridge/installation-plan.js';
import { assertInstallationSpace, recoveryDirectory } from '../src/bridge/installation-space.js';
import { DISK_RESERVE_BYTES, JOURNAL_BYTES_LIMIT, RECOVERY_BYTES_LIMIT } from '../src/bridge/installation-limits.js';
import { stateDir } from '../src/bridge/state.js';
import { workspaceFixture } from './bridge-fixture.js';

describe('Безопасность файлов, места и резервных копий установки', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const identity = { action: 'install' as const, assetKey: '1'.repeat(24), manifest: '2'.repeat(64) };
    const changes = [{ relative: 'файл.txt', before: null, after: 'данные' }];
    const pending = () => path.join(journalDirectory(fixture.root), 'pending.json');
    const target = () => path.join(fixture.root, 'файл.txt');
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    async function history(bytes = RECOVERY_BYTES_LIMIT) {
        const directory = path.join(journalDirectory(fixture.root), 'history'); await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, 'сохранённая-копия.json'); await fs.writeFile(file, ''); await fs.truncate(file, bytes); return file;
    }
    async function prepareJournal() {
        await fs.mkdir(journalDirectory(fixture.root), { recursive: true });
        const journal = { ...identity, version: 1, root: fixture.root, id: randomUUID(), state: 'prepared',
            changes: [{ relative: 'файл.txt', before: 'до', after: 'после' }] };
        await fs.writeFile(pending(), JSON.stringify(journal)); await fs.writeFile(target(), 'после'); return journal;
    }

    it('Снимок замечает замену inode при совпадающем содержимом', async () => {
        await fs.writeFile(target(), 'до'); const plan = new InstallationPlan(fixture.root);
        await plan.write('файл.txt', 'после'); await fs.rename(target(), target() + '.копия'); await fs.writeFile(target(), 'до');
        await expect(plan.verifySnapshot()).rejects.toThrow('изменился');
        await expect(commitChanges(fixture.root, plan.changes(), identity)).rejects.toThrow('изменился');
        expect(await readText(pending())).toBeNull(); expect(await fs.readFile(target(), 'utf8')).toBe('до');
    });
    it('Замена снимка после проверки блокирует commit до журнала', async () => {
        await fs.writeFile(target(), 'до'); const plan = new InstallationPlan(fixture.root);
        await plan.write('файл.txt', 'после'); await plan.verifySnapshot();
        await fs.rename(target(), target() + '.копия'); await fs.writeFile(target(), 'до');
        await expect(commitChanges(fixture.root, plan.changes(), identity)).rejects.toThrow('изменился');
        expect(await readText(pending())).toBeNull();
    });
    it('Лимит существующего файла проверяется до чтения и появления pending', async () => {
        await fs.writeFile(target(), ''); await fs.truncate(target(), 1048577);
        await expect(commitChanges(fixture.root, [{ relative: 'файл.txt', before: '', after: 'новое' }], identity)).rejects.toThrow('допустимого размера');
        expect(await readText(pending())).toBeNull(); expect((await fs.stat(target())).size).toBe(1048577);
    });
    it('Чтение большого JSON журнала ограничено до разбора', async () => {
        await fs.mkdir(journalDirectory(fixture.root), { recursive: true }); await fs.writeFile(pending(), ''); await fs.truncate(pending(), JOURNAL_BYTES_LIMIT + 1);
        await expect(withProjectFiles('test-project', async () => undefined)).rejects.toThrow('допустимого размера');
        expect((await fs.stat(pending())).size).toBe(JOURNAL_BYTES_LIMIT + 1);
        expect(await readText(target())).toBeNull();
    });
    it.skipIf(process.platform === 'win32')('Настоящий FIFO в журнале и управляемом файле не блокирует восстановление', async () => {
        await fs.mkdir(journalDirectory(fixture.root), { recursive: true }); await promisify(execFile)('mkfifo', [pending()]);
        await expect(withProjectFiles('test-project', async () => undefined)).rejects.toThrow('обычным файлом');
        await fs.unlink(pending()); await promisify(execFile)('mkfifo', [target()]);
        await expect(commitChanges(fixture.root, changes, identity)).rejects.toThrow('обычным файлом');
        expect(await readText(pending())).toBeNull();
    });
    it('Приватная папка журнала не может ссылаться на другую папку', async () => {
        const outside = path.join(fixture.temporary, 'чужая-папка'); await fs.mkdir(outside);
        await fs.mkdir(path.dirname(journalDirectory(fixture.root)), { recursive: true }); await fs.symlink(outside, journalDirectory(fixture.root));
        await expect(withProjectFiles('test-project', async () => undefined)).rejects.toThrow('симлинк');
        expect(await fs.readdir(outside)).toEqual([]);
    });
    it.skipIf(process.platform !== 'darwin')('Системный алиас macOS /var поддерживается без разрешения пользовательских симлинков', async () => {
        const directory = path.join(fixture.temporary.replace(/^\/private\/var\//, '/var/'), 'новая-папка');
        await recoveryDirectory(directory); expect((await fs.lstat(directory)).isDirectory()).toBe(true);
    });
    it('Недостаток места останавливает операцию до первого project lock и pending', async () => {
        vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 1n, bsize: 4096n } as Awaited<ReturnType<typeof fs.statfs>>);
        const action = vi.fn(); await expect(withProjectFiles('test-project', action)).rejects.toThrow('128 МиБ');
        expect(action).not.toHaveBeenCalled(); expect(await readText(pending())).toBeNull();
        expect(await readText(path.join(fixture.root, '.opencode/neurocenter/files.lock'))).toBeNull();
    });
    it('Общая файловая система резервирует суммарное место проекта и двух записей журнала', async () => {
        const journalBytes = 1048576; const fileBytes = 1048576;
        const bytes = BigInt(DISK_RESERVE_BYTES + 2 * journalBytes + 65536 + fileBytes + 8192);
        const statfs = vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: bytes, bsize: 1n } as Awaited<ReturnType<typeof fs.statfs>>);
        const set = [{ relative: 'файл', before: null, after: 'x'.repeat(fileBytes) }];
        await expect(assertInstallationSpace(fixture.root, journalBytes, set)).resolves.toBeUndefined(); expect(statfs).toHaveBeenCalledTimes(1);
        statfs.mockResolvedValue({ bavail: bytes - 1n, bsize: 1n } as Awaited<ReturnType<typeof fs.statfs>>);
        await expect(assertInstallationSpace(fixture.root, journalBytes, set)).rejects.toThrow('Недостаточно');
    });
    it('Недостаток места на отдельном диске проекта также запрещает запись', async () => {
        const lstat = fs.lstat.bind(fs); const state = stateDir();
        vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
            const stat = await lstat(...args);
            if (args[0] === fixture.root && typeof stat.dev === 'bigint') { return Object.assign(stat, { dev: stat.dev + 1n }); }
            return stat;
        });
        vi.spyOn(fs, 'statfs').mockImplementation(async file => ({ bavail: file === fixture.root ? 0n : 10n ** 12n, bsize: 1n }) as Awaited<ReturnType<typeof fs.statfs>>);
        await expect(assertInstallationSpace(fixture.root)).rejects.toThrow('Недостаточно'); expect(state).toBeTruthy();
    });
    it('Глубокие новые пути резервируют место для каждого уровня каталогов', async () => {
        const relative = Array.from({ length: 100 }, () => 'x').join('/') + '/file';
        const available = BigInt(DISK_RESERVE_BYTES + 65536 + 8192 * relative.split('/').length);
        const statfs = vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: available - 1n, bsize: 1n } as Awaited<ReturnType<typeof fs.statfs>>);
        await expect(assertInstallationSpace(fixture.root, 0, [{ relative, before: null, after: '' }])).rejects.toThrow('Недостаточно');
        statfs.mockResolvedValue({ bavail: available, bsize: 1n } as Awaited<ReturnType<typeof fs.statfs>>);
        await expect(assertInstallationSpace(fixture.root, 0, [{ relative, before: null, after: '' }])).resolves.toBeUndefined();
    });
    it('Квота 1 ГиБ сохраняет историю и отклоняет новую запись до pending', async () => {
        const file = await history();
        await expect(commitChanges(fixture.root, changes, identity)).rejects.toThrow('1 ГиБ');
        expect((await fs.stat(file)).size).toBe(RECOVERY_BYTES_LIMIT); expect(await readText(pending())).toBeNull(); expect(await readText(target())).toBeNull();
    });
    it('Квота суммирует pending других проектов текущего хаба', async () => {
        const directory = path.join(stateDir(), 'file-changes', 'a'.repeat(64)); await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, 'pending.json'); await fs.writeFile(file, ''); await fs.truncate(file, RECOVERY_BYTES_LIMIT);
        await expect(commitChanges(fixture.root, changes, identity)).rejects.toThrow('1 ГиБ');
        expect(await readText(pending())).toBeNull(); expect((await fs.stat(file)).size).toBe(RECOVERY_BYTES_LIMIT);
    });
    it('История другого хаба не сканируется и не расходует квоту', async () => {
        const directory = path.join(path.dirname(stateDir()), 'чужой-хаб', 'file-changes'); await fs.mkdir(directory, { recursive: true });
        await fs.symlink(fixture.root, path.join(directory, 'a'.repeat(64)));
        await expect(commitChanges(fixture.root, changes, identity)).resolves.toContain('history'); expect(await readText(target())).toBe('данные');
    });
    it('Уже подготовленный pending может безопасно завершить откат при исчерпанной квоте', async () => {
        const file = await history(); const journal = await prepareJournal();
        await withProjectFiles('test-project', async () => undefined);
        expect(await readText(target())).toBe('до'); expect(await readText(pending())).toBeNull();
        expect(JSON.parse(await fs.readFile(path.join(journalDirectory(fixture.root), 'history', journal.id + '.json'), 'utf8')).state).toBe('rolled-back');
        expect((await fs.stat(file)).size).toBe(RECOVERY_BYTES_LIMIT);
    });
    it('ENOSPC после первой записи откатывает файлы и сохраняет копию', async () => {
        await fs.writeFile(target(), 'до'); const link = fs.link.bind(fs); let failed = false;
        vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
            if (to === path.join(fixture.root, 'второй.txt') && !failed) { failed = true; throw Object.assign(new Error('диск полон'), { code: 'ENOSPC' }); }
            await link(from, to);
        });
        await expect(commitChanges(fixture.root, [{ relative: 'файл.txt', before: 'до', after: 'после' }, { relative: 'второй.txt', before: null, after: 'новый' }], identity)).rejects.toMatchObject({ code: 'ENOSPC' });
        expect(await readText(target())).toBe('до'); expect(await readText(path.join(fixture.root, 'второй.txt'))).toBeNull(); expect(await readText(pending())).toBeNull();
        expect(await fs.readdir(path.join(journalDirectory(fixture.root), 'history'))).toHaveLength(1);
    });
    it('Правка существующего файла во время staging не заменяется готовым временным файлом', async () => {
        await fs.writeFile(target(), 'до'); const rename = fs.rename.bind(fs); let changed = false;
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            await rename(from, to);
            if (String(to).endsWith('.staged') && !changed) { changed = true; await fs.writeFile(target(), 'моя правка'); }
        });
        await expect(commitChanges(fixture.root, [{ relative: 'файл.txt', before: 'до', after: 'после' }], identity)).rejects.toThrow('откат остановлен');
        expect(await readText(target())).toBe('моя правка'); expect(await readText(pending())).not.toBeNull();
    });
    it('Файл, появившийся во время staging, не перезаписывается', async () => {
        const rename = fs.rename.bind(fs); let changed = false;
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            await rename(from, to);
            if (String(to).endsWith('.staged') && !changed) { changed = true; await fs.writeFile(target(), 'моя правка'); }
        });
        await expect(commitChanges(fixture.root, changes, identity)).rejects.toThrow('откат остановлен');
        expect(await readText(target())).toBe('моя правка'); expect(await readText(pending())).not.toBeNull();
    });
});
