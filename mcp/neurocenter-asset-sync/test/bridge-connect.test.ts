import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectBridge, watchPair } from '../src/bridge/connect.js';
import { api, hash, readState, writeState, type Credentials } from '../src/bridge/state.js';
import { ensureCurrentWorker } from '../src/bridge/worker-upgrade.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));
vi.mock('../src/bridge/worker-upgrade.js', () => ({ ensureCurrentWorker: vi.fn(async () => undefined) }));
vi.mock('../src/bridge/open-browser.js', () => ({ openVerificationPage: vi.fn(async () => false) }));
vi.mock('../src/bridge/state.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/bridge/state.js')>(), api: vi.fn() }));

describe('Восстановление подключения без дубликатов компьютера', () => {
    let temporary: string;
    const identity = { id: 'same-device', email: 'fixture@example.test', role: 'Разработчик' };
    const pending = { deviceCode: 'a'.repeat(64), userCode: 'ABCDEF1234567890', expiresIn: 600, expiresAt: Date.now() + 600000, candidateToken: 'b'.repeat(64) };
    beforeEach(async () => {
        vi.clearAllMocks();
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-pairing-'));
        vi.stubEnv('NEUROCENTER_BRIDGE_HOME', temporary); vi.stubEnv('NEUROCENTER_URL', 'http://127.0.0.1:1');
        vi.mocked(ensureCurrentWorker).mockResolvedValue(undefined);
    });
    afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(temporary, { recursive: true, force: true }); });
    it('Повтор подключения использует действующий ID без новой пары', async () => {
        await writeState('credentials', { token: 'c'.repeat(64), deviceId: identity.id, email: identity.email });
        vi.mocked(api).mockResolvedValue(identity);
        expect(await connectBridge()).toMatchObject({ connected: true, deviceId: identity.id });
        expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(['identity']);
    });
    it('Будущий ключ сохраняется только локально, в запрос отправляется хэш', async () => {
        vi.mocked(api).mockResolvedValue({ deviceCode: pending.deviceCode, userCode: pending.userCode, expiresIn: 600 });
        const output = await connectBridge();
        const pair = await readState<typeof pending>('pair');
        expect(pair?.candidateToken).toHaveLength(64);
        expect(vi.mocked(api).mock.calls[0]?.[1]).toMatchObject({ credentialHash: hash(pair!.candidateToken) });
        expect(JSON.stringify(output)).not.toContain(pair!.candidateToken);
        expect(JSON.stringify(vi.mocked(api).mock.calls[0]?.[1])).not.toContain(pair!.candidateToken);
    });
    it('Повторное открытие ещё не подтверждённой пары сохраняет код и ключ', async () => {
        await writeState('pair', pending); vi.mocked(api).mockRejectedValue(new Error('Ещё не подтверждено'));
        expect(await connectBridge()).toMatchObject({ code: pending.userCode });
        expect((await readState<typeof pending>('pair'))?.candidateToken).toBe(pending.candidateToken);
        expect(vi.mocked(api).mock.calls.some(call => call[0] === 'pair/start')).toBe(false);
    });
    it('Потерянный ответ уже подтверждённой пары восстанавливается даже после истечения ссылки', async () => {
        await writeState('pair', { ...pending, expiresAt: 1 }); vi.mocked(api).mockResolvedValue(identity);
        expect(await connectBridge()).toMatchObject({ connected: true, deviceId: identity.id });
        expect((await readState<Credentials>('credentials'))?.token).toBe(pending.candidateToken);
        expect(await readState('pair')).toBeUndefined();
    });
    it('Poll сохраняет заранее созданный ключ, даже если сервер не возвращает секрет', async () => {
        await writeState('pair', pending); vi.mocked(api).mockResolvedValue({ state: 'connected', deviceId: identity.id, email: identity.email });
        await watchPair();
        expect(await readState('credentials')).toEqual({ token: pending.candidateToken, deviceId: identity.id, email: identity.email });
    });
    it('Старый наблюдатель пары не заменяет подключение после начала другой пары', async () => {
        await writeState('pair', pending);
        vi.mocked(api).mockImplementation(async () => {
            await writeState('pair', { ...pending, deviceCode: 'd'.repeat(64) });
            return { state: 'connected', deviceId: identity.id, email: identity.email } as never;
        });
        await watchPair(); expect(await readState('credentials')).toBeUndefined();
    });
    it('Занятый worker не заставляет создавать новую пару вместо сохранённого подключения', async () => {
        await writeState('credentials', { token: 'c'.repeat(64), deviceId: identity.id, email: identity.email });
        vi.mocked(api).mockResolvedValue(identity); vi.mocked(ensureCurrentWorker).mockRejectedValue(new Error('Обновление отложено'));
        await expect(connectBridge()).rejects.toThrow('Обновление отложено');
        expect(vi.mocked(api).mock.calls.some(call => call[0] === 'pair/start')).toBe(false);
    });
});
