import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    authorizedFetch,
    writeState,
    jobContext,
} from '../src/bridge/state.js';
describe('Личная авторизация MCP', () => {
    let root: string;
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-auth-'));
        vi.stubEnv('NEUROCENTER_BRIDGE_HOME', root);
        vi.stubEnv('NEUROCENTER_URL', 'https://hub.example.test');
        vi.stubGlobal('fetch', fetchMock);
        fetchMock.mockClear();
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        await fs.rm(root, { recursive: true, force: true });
    });
    it('Без подтверждения владельцем не обращается к сервисам', async () => {
        await expect(authorizedFetch('/api/projects')).rejects.toThrow(
            'connect_neurocenter',
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('Каждая порция фоновой синхронизации передаёт аренду для повторной проверки роли задания', async () => {
        await writeState('credentials', {
            token: 'fixture-token',
            deviceId: 'test',
            email: 'test@example.test',
        });
        await jobContext.run({ id: 'job-id', lease: 'lease-id' }, () =>
            authorizedFetch('/api/rag/chunks?projectKey=p'),
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'x-neurocenter-job-id': 'job-id',
                    'x-neurocenter-job-lease': 'lease-id',
                }),
            }),
        );
    });
    it('Использует площадку и отзываемый ключ, сохраняя заголовки запроса', async () => {
        await writeState('credentials', {
            token: 'fixture-token',
            deviceId: 'test',
            email: 'test@example.test',
        });
        await authorizedFetch('/api/rag/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://hub.example.test/api/rag/sync',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    authorization: 'Bearer fixture-token',
                },
            }),
        );
    });
});
