import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../src/storage/fs-skills-storage';
import { normalizeMeta, serializeSkillFile } from '../src/storage/frontmatter';
import { dependencyReservation, reserveSkillDependencies, type ISkillDependencyReservation } from '../src/storage/skill-dependency-reservation';
import { SKILL_JOURNAL_DIRECTORY } from '../src/storage/skill-journal';
import { SKILL_VERSIONS_DIRECTORY } from '../src/storage/skill-versions';

const pin = { kind: 'mcp' as const, id: 'ai-plug-dependency', version: 1, manifest: 'a'.repeat(64) };
const meta = (version = 1, dependencies = [pin]) => normalizeMeta({ name: 'Помощник', version, dependencies }, 'helper');

describe('Резервирование ссылок до файловой публикации', () => {
    let root: string;
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-reserve-')); });
    afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
    const contents = (relative: string) => fs.readFile(path.join(root, relative + '.md'), 'utf8');
    const fail = () => { throw new ConflictException('Пакет удалён.'); };

    it('Ключ учитывает весь сериализованный файл, включая ресурсы', () => {
        const raw = serializeSkillFile(meta(), 'Тело', [{ path: 'data.txt', content: 'Ресурс' }]);
        expect(dependencyReservation('common/helper', raw)).toEqual({ path: 'common/helper', key: createHash('sha256').update(raw).digest('hex'), dependencies: [pin] });
        expect(dependencyReservation('common/helper', serializeSkillFile(meta(1, []), 'Тело'))).toBeUndefined();
    });
    it.each(['create', 'write'] as const)('Не создаёт ни файла, ни каталога при отказе %s', async method => {
        const storage = new FsSkillsStorage(root, async () => fail());
        const action = method === 'create' ? storage.createSkill('common/helper', meta(), 'Текст') : storage.writeSkill('common/helper', meta(), 'Текст');
        await expect(action).rejects.toMatchObject({ status: 409 });
        expect(await fs.readdir(root)).toEqual([]);
    });
    it('Перед созданием подтверждает точную ссылку, а локальный адаптер не требует HTTP', async () => {
        const reserve = vi.fn(async (entries: ISkillDependencyReservation[]) => {
            expect(await fs.readdir(root)).toEqual([]);
            expect(entries[0].dependencies).toEqual([pin]);
        });
        await new FsSkillsStorage(root, reserve).createSkill('common/helper', meta(), 'Текст');
        expect(reserve).toHaveBeenCalledOnce();
        expect(await contents('common/helper')).toContain('Текст');
    });
    it.each(['write', 'delete'] as const)('Сохраняет голову и не создаёт историю при отказе старых pins: %s', async method => {
        await new FsSkillsStorage(root).writeSkill('common/helper', meta(), 'Исходный текст');
        const before = await contents('common/helper');
        const storage = new FsSkillsStorage(root, async () => fail());
        const action = method === 'write' ? storage.writeSkill('common/helper', meta(2, []), 'Новый текст') : storage.deleteSkill('common/helper');
        await expect(action).rejects.toMatchObject({ status: 409 });
        expect(await contents('common/helper')).toBe(before);
        expect(await fs.readdir(root)).not.toContain(SKILL_VERSIONS_DIRECTORY);
    });
    it('Обновление подтверждает новую и сохраняемую старую зависимости до смены головы', async () => {
        await new FsSkillsStorage(root).writeSkill('common/helper', meta(), 'Исходный текст');
        const reserve = vi.fn(async () => { expect(await contents('common/helper')).toContain('Исходный текст'); });
        await new FsSkillsStorage(root, reserve).writeSkill('common/helper', meta(2, [{ ...pin, version: 2 }]), 'Новый текст');
        expect(reserve.mock.calls.map(call => (call as unknown as [ISkillDependencyReservation[]])[0][0].dependencies[0].version)).toEqual([2, 1]);
    });
    it('Проверяет весь before/after пакет до журнала и первой файловой записи', async () => {
        const local = new FsSkillsStorage(root);
        await local.writeSkill('project-test/first', meta(), 'Первый исходный');
        await local.writeSkill('project-test/second', meta(), 'Второй исходный');
        const reserve = vi.fn(async (entries: ISkillDependencyReservation[]) => {
            expect(entries).toHaveLength(4);
            expect(entries.map(entry => entry.dependencies[0].version)).toEqual([1, 2, 1, 2]);
            expect(await fs.readdir(path.join(root,SKILL_JOURNAL_DIRECTORY))).toEqual([]);
            expect(await contents('project-test/first')).toContain('Первый исходный');
            fail();
        });
        await expect(new FsSkillsStorage(root, reserve).applySkillChanges(['first', 'second'].map(slug => ({
            path: 'project-test/' + slug, next: { path: 'project-test/' + slug, meta: meta(2, [{ ...pin, version: 2 }]), body: 'Новый' },
        })))).rejects.toMatchObject({ status: 409 });
        expect(reserve).toHaveBeenCalledOnce();
        expect(await contents('project-test/second')).toContain('Второй исходный');
        expect(await fs.readdir(root)).toEqual([SKILL_JOURNAL_DIRECTORY,'project-test']);
    });
    it('Ошибка повторной проверки внутри пакета откатывает запись без нового запроса каталога', async () => {
        const local = new FsSkillsStorage(root);
        await local.writeSkill('project-test/first', meta(), 'Первый исходный');
        await local.writeSkill('project-test/second', meta(), 'Второй исходный');
        const reserve = vi.fn<(...args: [ISkillDependencyReservation[]]) => Promise<void>>()
            .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValue(new Error('Каталог отключён'));
        await expect(new FsSkillsStorage(root, reserve).applySkillChanges(['first', 'second'].map(slug => ({
            path: 'project-test/' + slug, next: { path: 'project-test/' + slug, meta: meta(2), body: 'Новый' },
        })))).rejects.toThrow('Каталог отключён');
        expect(reserve).toHaveBeenCalledTimes(4);
        expect(await contents('project-test/first')).toContain('Первый исходный');
        expect(await contents('project-test/second')).toContain('Второй исходный');
        expect(await fs.readdir(path.join(root, SKILL_JOURNAL_DIRECTORY))).toEqual([]);
    });
    it('Отказ второй части большого резервирования оставляет весь файловый пакет прежним', async () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'a'.repeat(64));
        const request = vi.fn(async (_url: URL, options: RequestInit) => {
            const entries = JSON.parse(options.body as string).entries as ISkillDependencyReservation[];
            expect(await fs.readdir(root)).toEqual([]);
            if (entries.length < 200) { return new Response(JSON.stringify({ message: 'Версия исчезла.' }), { status: 409 }); }
            return new Response(JSON.stringify({ ok: true, reserved: entries.length }));
        });
        vi.stubGlobal('fetch', request);
        try {
            await expect(new FsSkillsStorage(root, reserveSkillDependencies).applySkillChanges(Array.from({ length: 201 }, (_, i) => ({
                path: 'project-test/helper-' + i, next: { path: 'project-test/helper-' + i, meta: meta(), body: 'Новый текст ' + i },
            })))).rejects.toMatchObject({ status: 409 });
            expect(request).toHaveBeenCalledTimes(2);
            expect(await fs.readdir(root)).toEqual([]);
        } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
    });
    it('Восстановление прежнего prepared-журнала не пишет файл без проверки pins', async () => {
        const directory = path.join(root, SKILL_JOURNAL_DIRECTORY);
        await fs.mkdir(directory);
        const raw = serializeSkillFile(meta(), 'Прежний текст');
        const filename = path.join(directory, createHash('sha256').update('common').digest('hex') + '.json');
        await fs.writeFile(filename, JSON.stringify({ version: 1, id: 'old', state: 'prepared', host: os.hostname(), pid: process.pid, changes: [{ relative: 'common/helper.md', before: raw, after: null }] }));
        await expect(new FsSkillsStorage(root, async () => fail()).init()).rejects.toMatchObject({ status: 409 });
        expect(await fs.readFile(filename, 'utf8')).toContain('prepared');
        await expect(contents('common/helper')).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('Инициализация не импортирует ассеты и не требует доступности каталога', async () => {
        const reserve = vi.fn(async () => fail());
        await new FsSkillsStorage(root, reserve).init();
        expect(reserve).not.toHaveBeenCalled();
        expect(await fs.readdir(root)).not.toContain('common');
    });
});

describe('HTTP-подтверждение каталога', () => {
    const entries = [dependencyReservation('common/helper', serializeSkillFile(meta(), 'Текст'))!];
    beforeEach(() => { vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'a'.repeat(64)); vi.stubEnv('CATALOG_SERVICE_URL', 'http://127.0.0.1:4100'); });
    afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    it('Посылает весь набор одним запросом с внутренним токеном и таймаутом', async () => {
        const request = vi.fn(async () => response({ ok: true, reserved: 1 }));
        vi.stubGlobal('fetch', request);
        await reserveSkillDependencies(entries);
        expect(request).toHaveBeenCalledOnce();
        const [, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
        expect(options.headers).toMatchObject({ 'x-neurocenter-internal': 'a'.repeat(64) });
        expect(JSON.parse(options.body as string)).toEqual({ entries });
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.redirect).toBe('error');
    });
    it.each(['publish', 'preserve'] as const)('Передаёт только поля внутреннего договора с назначением %s', async purpose => {
        const request = vi.fn(async () => response({ ok: true, reserved: 1 }));
        vi.stubGlobal('fetch', request);
        await reserveSkillDependencies([{ ...entries[0], purpose, actor: 'Подмена', raw: 'Не передавать' } as ISkillDependencyReservation]);
        const [, options] = request.mock.calls[0] as unknown as [URL, RequestInit];
        expect(JSON.parse(options.body as string)).toEqual({ entries: [{ ...entries[0], purpose }] });
    });
    it.each(['restore', '', null, 1])('Не отправляет неизвестное назначение %j в каталог', async purpose => {
        const request = vi.fn(); vi.stubGlobal('fetch', request);
        await expect(reserveSkillDependencies([{ ...entries[0], purpose } as ISkillDependencyReservation])).rejects.toThrow('Повреждён пакет');
        expect(request).not.toHaveBeenCalled();
    });
    it('Большой набор регистрирует последовательными частями до 200 записей', async () => {
        const sizes: number[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: URL, options: RequestInit) => {
            const entries = JSON.parse(options.body as string).entries as ISkillDependencyReservation[];
            sizes.push(entries.length);
            return response({ ok: true, reserved: entries.length });
        }));
        await reserveSkillDependencies(Array.from({ length: 405 }, (_, i) => ({ ...entries[0], path: 'common/helper-' + i })));
        expect(sizes).toEqual([200, 200, 5]);
    });
    it('Неверная запись в поздней части пакета отклоняется до первого HTTP-запроса', async () => {
        const request = vi.fn(); vi.stubGlobal('fetch', request);
        const batch = Array.from({ length: 201 }, (_, i) => ({ ...entries[0], path: 'common/helper-' + i }));
        batch[200].key = 'invalid';
        await expect(reserveSkillDependencies(batch)).rejects.toThrow('Повреждён пакет');
        expect(request).not.toHaveBeenCalled();
    });
    it('Пустой набор не обращается к каталогу', async () => {
        const request = vi.fn(); vi.stubGlobal('fetch', request);
        await reserveSkillDependencies([]); expect(request).not.toHaveBeenCalled();
    });
    it('Конфликт каталога остаётся 409 с объяснением', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'Версия MCP отсутствует.' }, 409)));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 409, message: 'Версия MCP отсутствует.' });
    });
    it('HTTP 409 остаётся конфликтом даже при повреждённом теле ответа', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{', { status: 409 })));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 409 });
    });
    it.each([403, 500, 503])('Отказ HTTP %s не позволяет публиковать файл', async status => {
        vi.stubGlobal('fetch', vi.fn(async () => response({ message: 'Отказ' }, status)));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 503 });
    });
    it.each([{}, { ok: true }, { ok: true, reserved: -1 }, { ok: true, reserved: 0 }, { ok: true, reserved: 2 }, { ok: false, reserved: 1 }, null])('Неполное подтверждение %j останавливает публикацию', async body => {
        vi.stubGlobal('fetch', vi.fn(async () => response(body)));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 502 });
    });
    it('Повреждённый JSON и сетевой таймаут диагностируются раздельно', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{')));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 502 });
        vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Timeout', 'TimeoutError'); }));
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 503 });
    });
    it('Не начинает запрос с отсутствующим токеном или некорректным пакетом', async () => {
        const request = vi.fn(); vi.stubGlobal('fetch', request);
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', '');
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 503 });
        await expect(reserveSkillDependencies([{ ...entries[0], dependencies: [{ ...pin, version: 0 }] }])).rejects.toThrow('Зависимость');
        expect(request).not.toHaveBeenCalled();
    });
    it.each(['file:///tmp/catalog', 'https://user:password@example.test', 'not-a-url'])('Не передаёт внутренний токен на некорректный адрес %s', async endpoint => {
        const request = vi.fn(); vi.stubGlobal('fetch', request); vi.stubEnv('CATALOG_SERVICE_URL', endpoint);
        await expect(reserveSkillDependencies(entries)).rejects.toMatchObject({ status: 503 });
        expect(request).not.toHaveBeenCalled();
    });
});
