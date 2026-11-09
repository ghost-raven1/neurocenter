import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../../src/storage/fs-skills-storage';
import { SkillsService } from '../../src/skills/skills.service';
import {
    deliverSkillQuotaUsage,
    projectIdFromSkillPath,
    skillQuotaRequestKey,
    skillQuotaUsageRecords,
    type ISkillQuotaUsageRecord,
} from '../../src/storage/quota-usage';
import type { ISkillFileChange } from '../../src/storage/skill-journal';

const actor = 'operator@example.test';

describe('Атрибуция и записи учёта quota скиллов', () => {
    it('каталог project-<key> атрибутируется в проект', () => {
        expect(projectIdFromSkillPath('project-abc-123/helper')).toBe('abc-123');
    });

    it('общие скиллы (без projectId) не учитываются', () => {
        expect(projectIdFromSkillPath('library/helper')).toBeNull();
        expect(projectIdFromSkillPath('project-')).toBeNull();
    });

    const entry = (relative: string, before: string | null, after: string | null): ISkillFileChange => ({
        relative,
        before,
        after,
    });

    it('дельта по байтам сериализованных файлов', () => {
        const records = skillQuotaUsageRecords([
            { entry: entry('project-p1/new.md', null, 'новая инструкция'), metaProjectId: 'p1' },
            { entry: entry('project-p1/gone.md', 'старая инструкция', null), metaProjectId: null },
        ]);
        expect(records.map((record) => [record.projectId, record.deltaBytes])).toEqual([
            ['p1', Buffer.byteLength('новая инструкция', 'utf8')],
            ['p1', -Buffer.byteLength('старая инструкция', 'utf8')],
        ]);
    });

    it('meta.projectId имеет приоритет над путём; common/ и нулевые дельты пропускаются', () => {
        const records = skillQuotaUsageRecords([
            { entry: entry('project-p1/moved.md', 'x', 'yy'), metaProjectId: 'other' },
            { entry: entry('library/common.md', null, 'общий'), metaProjectId: null },
            { entry: entry('project-p1/same.md', 'одинаково', 'одинаково'), metaProjectId: 'p1' },
        ]);
        expect(records.map((record) => record.projectId)).toEqual(['other']);
    });

    it('ключ идемпотентности детерминирован и различает содержимое', () => {
        const base = entry('project-p1/helper.md', null, 'текст');
        expect(skillQuotaRequestKey(base)).toBe(skillQuotaRequestKey({ ...base }));
        expect(skillQuotaRequestKey(base)).not.toBe(skillQuotaRequestKey(entry('project-p1/helper.md', null, 'другой')));
        expect(skillQuotaRequestKey(base).startsWith('skill:project-p1/helper.md:')).toBe(true);
    });
});

describe('Доставка учёта quota в catalog (best-effort)', () => {
    const record = (partial: Partial<ISkillQuotaUsageRecord> = {}): ISkillQuotaUsageRecord => ({
        projectId: 'p1',
        deltaBytes: 128,
        requestKey: 'skill:project-p1/helper.md:deadbeef',
        ...partial,
    });

    it('пустой список — без запросов', async () => {
        const fetchImpl = vi.fn() as unknown as typeof globalThis.fetch;
        await expect(deliverSkillQuotaUsage([], { fetchImpl })).resolves.toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('отправляет POST с dimension current и internal-токеном', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 202 })) as unknown as typeof globalThis.fetch;
        const delivered = await deliverSkillQuotaUsage([record()], {
            catalogUrl: 'http://catalog:4100',
            internalToken: 'token-1',
            fetchImpl,
        });
        expect(delivered).toBe(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://catalog:4100/internal/projects/p1/quota-usage');
        expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-neurocenter-internal': 'token-1' });
        expect(JSON.parse(String(init.body))).toEqual({ dimension: 'current', deltaBytes: 128, requestKey: record().requestKey });
    });

    it('ошибка доставки не пробрасывается наружу', async () => {
        const warn = vi.fn();
        const fetchImpl = vi.fn(async () => {
            throw new Error('catalog unavailable');
        }) as unknown as typeof globalThis.fetch;
        await expect(deliverSkillQuotaUsage([record()], { fetchImpl, warn })).resolves.toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('quota usage delivery failed');
    });

    it('не-ok статус не считается доставленным, остальные записи уходят дальше', async () => {
        const warn = vi.fn();
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(new Response(null, { status: 202 })) as unknown as typeof globalThis.fetch;
        const delivered = await deliverSkillQuotaUsage([record({ requestKey: 'a' }), record({ requestKey: 'b' })], {
            fetchImpl,
            warn,
        });
        expect(delivered).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('requestKey=a');
    });
});

describe('Хук quota в applyChangesLocked', () => {
    let root: string;

    const created: FsSkillsStorage[] = [];
    const storage = (records: ISkillQuotaUsageRecord[]) => {
        const item = new FsSkillsStorage(root, undefined, undefined, (items) => {
            records.push(...items);
            return Promise.resolve();
        });
        created.push(item);
        return item;
    };

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-quota-'));
        vi.stubEnv('NODE_ENV', 'production');
    });

    afterEach(async () => {
        for (const item of created.splice(0)) {
            await item.onModuleDestroy();
        }
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await fs.rm(root, { recursive: true, force: true });
    });

    it('create/update/delete дают точные дельты, сумма за жизненный цикл = 0', async () => {
        const records: ISkillQuotaUsageRecord[] = [];
        const service = new SkillsService(storage(records));
        const createdSkill = await service.createSkill(
            { path: 'project-quota-key', slug: 'helper', name: 'Помощник', body: 'Первая инструкция' },
            'user-id',
            actor,
        );
        expect(records.length).toBe(1);
        expect(records[0].projectId).toBe('quota-key');
        expect(records[0].deltaBytes).toBeGreaterThan(0);
        expect(records[0].requestKey.startsWith('skill:project-quota-key/helper.md:')).toBe(true);

        const firstBytes = records[0].deltaBytes;
        await service.updateSkill(createdSkill.path, { expectedVersion: 1, body: 'Вторая, более длинная инструкция' }, 'user-id', actor);
        expect(records.length).toBe(2);
        expect(records[1].deltaBytes).toBeGreaterThan(0);

        await service.deleteSkill(createdSkill.path, actor);
        expect(records.length).toBe(3);
        expect(records[2].deltaBytes).toBeLessThan(0);

        const total = records.reduce((sum, record) => sum + record.deltaBytes, 0);
        expect(total).toBe(0);
        // Финальные байты файла = стартовые + дельта обновления.
        expect(-records[2].deltaBytes).toBe(firstBytes + records[1].deltaBytes);
    });

    it('общие скиллы (common) не создают записей', async () => {
        const records: ISkillQuotaUsageRecord[] = [];
        const service = new SkillsService(storage(records));
        await service.createSkill(
            { path: 'library', slug: 'common-skill', name: 'Общий', body: 'Общая инструкция' },
            'user-id',
            actor,
        );
        await service.deleteSkill('library/common-skill', actor);
        expect(records).toEqual([]);
    });
});
