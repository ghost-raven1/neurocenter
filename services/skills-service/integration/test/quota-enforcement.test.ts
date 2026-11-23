import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsSkillsStorage } from '../../src/storage/fs-skills-storage';
import { SkillsService } from '../../src/skills/skills.service';
import { enforceSkillQuota } from '../../src/storage/quota-usage';

const actor = 'operator@example.test';
const CURRENT_EXCEEDED =
    'Лимит объёма файлов проекта превышен. Операция не начата. Обратитесь к администратору.';
const QUOTA_UNAVAILABLE = 'Лимиты проекта не подтверждены. Операция не начата. Обратитесь к администратору.';
// Сериализованный файл (frontmatter + тело) заметно больше 100 байт.
const BODY = 'Инструкция для помощника проекта. '.repeat(12);

/** Снимок accounting: used/limit измерения current, остальные измерения нулевые. */
const quotaResponse = (used: number, limit: number) =>
    new Response(
        JSON.stringify({
            used: { current: used, retention: 0, staging: 0 },
            limits: { current: limit, retention: 0, staging: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );

const expectQuotaError = async (promise: Promise<unknown>, statusCode: number, message: string): Promise<void> => {
    const error = await promise.catch((value) => value);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(statusCode);
    expect((error as HttpException).message).toBe(message);
};

describe('Enforcement currentBytesLimit ДО durable-записи (AD-D4)', () => {
    let root: string;
    let storage: FsSkillsStorage | undefined;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-skill-enforce-'));
        vi.stubEnv('NODE_ENV', 'production');
        vi.stubEnv('CATALOG_SERVICE_URL', 'http://catalog:4100');
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'internal-token');
    });
    afterEach(async () => {
        await storage?.onModuleDestroy();
        storage = undefined;
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        await fs.rm(root, { recursive: true, force: true });
    });

    const buildService = (fetchImpl: typeof globalThis.fetch): SkillsService => {
        vi.stubGlobal('fetch', fetchImpl);
        storage = new FsSkillsStorage(root, undefined, undefined, (items) => Promise.resolve(), enforceSkillQuota);
        return new SkillsService(storage);
    };

    it('сохранение сверх currentBytesLimit — 507, артефактов нет (файла и журнала нет)', async () => {
        const fetchImpl = vi.fn(async () => quotaResponse(0, 100));
        const service = buildService(fetchImpl);
        await expectQuotaError(
            service.createSkill({ path: 'project-quota-key', slug: 'helper', name: 'Помощник', body: BODY }, 'user-id', actor),
            507,
            CURRENT_EXCEEDED,
        );
        await expect(fs.access(path.join(root, 'project-quota-key', 'helper.md'))).rejects.toThrow();
        await expect(fs.access(path.join(root, '.neurocenter-sync-journal'))).rejects.toThrow();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://catalog:4100/internal/projects/quota-key/quota-usage');
        expect(init.method).toBe('GET');
        expect(init.headers).toEqual({ 'x-neurocenter-internal': 'internal-token' });
    });

    it('limit=0 (unlimited) — лимит прочитан из accounting, запись прошла', async () => {
        const fetchImpl = vi.fn(async () => quotaResponse(9_999_999, 0));
        const service = buildService(fetchImpl);
        const created = await service.createSkill(
            { path: 'project-quota-key', slug: 'helper', name: 'Помощник', body: BODY },
            'user-id',
            actor,
        );
        expect(created.path).toBe('project-quota-key/helper');
        await expect(fs.access(path.join(root, 'project-quota-key', 'helper.md'))).resolves.toBeUndefined();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
            'http://catalog:4100/internal/projects/quota-key/quota-usage',
        );
    });

    it('accounting недоступен — fail-closed 503, запись не прошла', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('catalog down');
        });
        const service = buildService(fetchImpl);
        await expectQuotaError(
            service.createSkill({ path: 'project-quota-key', slug: 'helper', name: 'Помощник', body: BODY }, 'user-id', actor),
            503,
            QUOTA_UNAVAILABLE,
        );
        await expect(fs.access(path.join(root, 'project-quota-key', 'helper.md'))).rejects.toThrow();
    });

    it('общие скиллы (library) — enforcement не применяется, каталог не опрашивается', async () => {
        const fetchImpl = vi.fn(async () => quotaResponse(0, 100));
        const service = buildService(fetchImpl);
        const created = await service.createSkill(
            { path: 'library', slug: 'common-skill', name: 'Общий', body: BODY },
            'user-id',
            actor,
        );
        expect(created.path).toBe('library/common-skill');
        await expect(fs.access(path.join(root, 'library', 'common-skill.md'))).resolves.toBeUndefined();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
