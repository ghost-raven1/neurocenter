import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillsService } from '../src/skills/skills.service';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { normalizeMeta, serializeSkillFile } from '../src/storage/frontmatter';
import { SKILL_JOURNAL_DIRECTORY } from '../src/storage/skill-journal';
import { SKILL_VERSIONS_DIRECTORY, versionRelative } from '../src/storage/skill-versions';
import type { ISkillDependencyReservation } from '../src/storage/skill-dependency-reservation';

const broken = { kind: 'mcp' as const, id: 'ai-plug-missing', version: 1, manifest: 'a'.repeat(64) };
const available = { ...broken, id: 'ai-plug-available', manifest: 'b'.repeat(64) };
const relative = 'project-test/helper';
const journalName = createHash('sha256').update('project-test').digest('hex') + '.json';
const initialMeta = () => normalizeMeta({ name: 'Помощник', version: 1, scope: 'project', projectId: 'test', dependencies: [broken] }, 'helper');

describe('Исправление скиллов со старой недоступной зависимостью', () => {
    let root: string;
    let original: string;
    let service: SkillsService;
    let reserve: ReturnType<typeof vi.fn<(entries: ISkillDependencyReservation[]) => Promise<void>>>;
    const contents = () => fs.readFile(path.join(root, relative + '.md'), 'utf8');
    const strict = async (entries: ISkillDependencyReservation[]) => {
        for (const entry of entries) {
            if (entry.purpose !== 'preserve' && entry.dependencies.some(pin => pin.id === broken.id)) {
                throw new ConflictException('Старая зависимость недоступна.');
            }
        }
    };
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-legacy-repair-'));
        await new FsSkillsStorage(root).writeSkill(relative, initialMeta(), 'Исходная инструкция');
        original = await contents();
        reserve = vi.fn(strict);
        service = new SkillsService(new FsSkillsStorage(root, reserve));
    });
    afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
    const expectUnchanged = async () => {
        expect(await contents()).toBe(original);
        expect(await fs.readdir(root)).not.toContain(SKILL_VERSIONS_DIRECTORY);
    };
    const expectSnapshot = async () => {
        expect(await fs.readFile(path.join(root, versionRelative(relative, initialMeta(), 1)), 'utf8')).toBe(original);
    };

    it.each([{}, { body: 'Исходная инструкция', name: 'Помощник', resources: [] }, { purpose: 'preserve', meta: { purpose: 'preserve' } }])('Сохранение без изменений %j не публикует старую недоступную зависимость заново', async request => {
        const result = await service.updateSkill(relative, { expectedVersion: 1, ...request } as never, 'repairer');
        expect(result.meta.version).toBe(1);
        expect(result.meta.dependencies).toEqual([broken]);
        expect(reserve).not.toHaveBeenCalled();
        await expectUnchanged();
    });
    it.each([{ request: { expectedVersion: 2 }, status: 409 }, { request: { resources: [{ path: 'outside.txt', content: 'Данные' }] }, status: 400 }])('Сохранение без изменений всё равно проверяет версию и ввод %j', async ({ request, status }) => {
        await expect(service.updateSkill(relative, request, 'repairer')).rejects.toMatchObject({ status });
        expect(reserve).not.toHaveBeenCalled();
        await expectUnchanged();
    });
    it.each(['clear', 'replace'] as const)('Позволяет %s зависимость, сохраняя точный старый текст в истории', async action => {
        const dependencies = action === 'clear' ? [] : [available];
        const result = await service.updateSkill(relative, { expectedVersion: 1, meta: { dependencies } }, 'repairer');
        expect(result.meta.version).toBe(2);
        expect(result.meta.dependencies ?? []).toEqual(dependencies);
        await expectSnapshot();
        const old = reserve.mock.calls.flatMap(([entries]) => entries).filter(entry => entry.dependencies[0]?.id === broken.id);
        expect(old.length).toBeGreaterThan(0);
        expect(old.every(entry => entry.purpose === 'preserve')).toBe(true);
    });
    it('Позволяет удалить старый скилл с сохранением истории', async () => {
        await expect(service.deleteSkill(relative)).resolves.toMatchObject({ ok: true });
        await expect(contents()).rejects.toMatchObject({ code: 'ENOENT' });
        await expectSnapshot();
        expect(reserve.mock.calls.flatMap(([entries]) => entries).every(entry => entry.purpose === 'preserve')).toBe(true);
    });
    it.each([{ body: 'Другая инструкция' }, { name: 'Другое имя' }, { resources: [{ path: 'assets/info.txt', content: 'Данные' }] }])('Не публикует правку %j с прежней недоступной зависимостью', async request => {
        await expect(service.updateSkill(relative, { expectedVersion: 1, ...request }, 'repairer')).rejects.toMatchObject({ status: 409 });
        await expectUnchanged();
    });
    it('Копирование старой версии в новую карточку остаётся строгой публикацией', async () => {
        const old = await service.getSkill(relative);
        await expect(service.createSkill({ path: 'project-test', slug: 'copy', name: old.meta.name, body: old.body, meta: old.meta }, 'repairer')).rejects.toMatchObject({ status: 409 });
        await expect(fs.readFile(path.join(root, 'project-test/copy.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await expectUnchanged();
    });
    it.each(['write', 'delete'] as const)('Отказ регистрации сохраняемого текста останавливает %s до истории и головы', async action => {
        reserve.mockImplementation(async entries => {
            if (entries.some(entry => entry.purpose === 'preserve')) { throw new ServiceUnavailableException('Аудит недоступен.'); }
            await strict(entries);
        });
        const work = action === 'delete' ? service.deleteSkill(relative) : service.updateSkill(relative, { meta: { dependencies: [] } }, 'repairer');
        await expect(work).rejects.toMatchObject({ status: 503 });
        await expectUnchanged();
    });
    it('Пакет синхронизации может очистить зависимость и сохраняет старую версию', async () => {
        await service.syncSkills('test', [{ slug: 'helper', name: 'Помощник', body: 'Исправленная инструкция', version: 1, dependencies: [] }]);
        expect((await service.getSkill(relative)).meta.dependencies).toBeUndefined();
        await expectSnapshot();
    });
    it.each([false, true])('Строгая проверка выигрывает у сохранения одинакового текста при порядке %s', async reverse => {
        const current = await service.getSkill(relative);
        const changes = [{ path: relative, next: current }, { path: relative, next: null }];
        if (reverse) { changes.reverse(); }
        await expect(new FsSkillsStorage(root, reserve).applySkillChanges(changes)).rejects.toMatchObject({ status: 409 });
        await expectUnchanged();
        expect(await fs.readdir(path.join(root,SKILL_JOURNAL_DIRECTORY))).toEqual([]);
    });
    it.each(['create', 'update', 'sync'] as const)('Поддельное purpose в публичном %s не ослабляет проверку новой версии', async action => {
        const forged = { purpose: 'preserve' };
        const work = action === 'create'
            ? service.createSkill({ path: 'project-test', slug: 'forged', name: 'Подмена', body: 'Текст', ...forged, meta: { dependencies: [broken], ...forged } }, 'repairer')
            : action === 'update'
                ? service.updateSkill(relative, { body: 'Подмена', ...forged, meta: forged as never }, 'repairer')
                : service.syncSkills('test', [{ slug: 'helper', name: 'Помощник', body: 'Подмена', version: 1, dependencies: [broken], ...forged }]);
        await expect(work).rejects.toMatchObject({ status: 409 });
        await expectUnchanged();
    });
    it('Повреждённая структура старого pin не сохраняется как допустимая история', async () => {
        const malformed = original.replace('version: 1\n    manifest:', 'version: 0\n    manifest:');
        expect(malformed).not.toBe(original);
        await fs.writeFile(path.join(root, relative + '.md'), malformed);
        await expect(service.deleteSkill(relative)).rejects.toThrow('Зависимость');
        expect(await contents()).toBe(malformed);
        expect(reserve).not.toHaveBeenCalled();
    });
    it('Prepared-журнал со старой недоступной зависимостью восстанавливается через сохранение', async () => {
        const after = serializeSkillFile(normalizeMeta({ ...initialMeta(), version: 2, dependencies: [] }, 'helper'), 'Новая инструкция');
        await fs.writeFile(path.join(root, relative + '.md'), after);
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory,{recursive:true});
        const filename = path.join(directory, journalName);
        await fs.writeFile(filename, JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid, changes: [{ relative: relative + '.md', before: original, after }] }));
        await new FsSkillsStorage(root, reserve).init();
        expect(await contents()).toBe(original);
        expect(reserve.mock.calls.flatMap(([entries]) => entries).every(entry => entry.purpose === 'preserve')).toBe(true);
        expect(await fs.readdir(directory)).toEqual([]);
    });
    it('При откате обе стороны старого журнала сохраняются, даже если недоступна только новая зависимость', async () => {
        const before = serializeSkillFile(normalizeMeta({ ...initialMeta(), dependencies: [] }, 'helper'), 'До сбоя');
        await fs.writeFile(path.join(root, relative + '.md'), original);
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory, journalName), JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid,
            changes: [{ relative: relative + '.md', before, after: original }] }));
        await new FsSkillsStorage(root, reserve).init();
        expect(await contents()).toBe(before);
        expect(reserve.mock.calls.flatMap(([entries]) => entries)).toEqual([expect.objectContaining({ purpose: 'preserve', dependencies: [broken] })]);
    });
    it('Ручная правка после сбоя блокирует восстановление до обращения к каталогу', async () => {
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory,{recursive:true});
        const filename = path.join(directory, journalName);
        await fs.writeFile(filename, JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid,
            changes: [{ relative: relative + '.md', before: original, after: null }] }));
        await fs.writeFile(path.join(root, relative + '.md'), 'Ручная правка');
        await expect(new FsSkillsStorage(root, reserve).init()).rejects.toThrow('Автоматический откат остановлен');
        expect(await contents()).toBe('Ручная правка');
        expect(reserve).not.toHaveBeenCalled();
        expect(await fs.readFile(filename, 'utf8')).toContain('prepared');
    });
    it('Новая синхронизация сначала восстанавливает прежний журнал через сохранение недоступных pins', async () => {
        const afterMeta = normalizeMeta({ ...initialMeta(), version: 2, dependencies: [] }, 'helper');
        const after = serializeSkillFile(afterMeta, 'Незавершённая инструкция');
        await fs.writeFile(path.join(root, relative + '.md'), after);
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory, journalName), JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid,
            changes: [{ relative: relative + '.md', before: original, after }] }));
        await new FsSkillsStorage(root, reserve).applySkillChanges([{ path: relative, next: {
            path: relative, meta: { ...afterMeta, version: 3 }, body: 'Исправленная инструкция',
        } }]);
        expect((await service.getSkill(relative)).body).toBe('Исправленная инструкция');
        await expectSnapshot();
        expect(reserve.mock.calls.flatMap(([entries]) => entries).every(entry => entry.purpose === 'preserve')).toBe(true);
        expect(await fs.readdir(directory)).toEqual([]);
    });
    it('Отказ сохранения при восстановлении оставляет prepared-журнал и текущую голову', async () => {
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory,{recursive:true});
        const filename = path.join(directory, journalName);
        await fs.writeFile(filename, JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid, changes: [{ relative: relative + '.md', before: original, after: null }] }));
        await fs.rm(path.join(root, relative + '.md'));
        reserve.mockRejectedValue(new ServiceUnavailableException('Каталог недоступен.'));
        await expect(new FsSkillsStorage(root, reserve).init()).rejects.toMatchObject({ status: 503 });
        await expect(contents()).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(filename, 'utf8')).toContain('prepared');
    });
});
