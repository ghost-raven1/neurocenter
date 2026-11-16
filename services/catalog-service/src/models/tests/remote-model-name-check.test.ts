import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import { checkRemoteModelName, REMOTE_MODEL_NAME_UNVERIFIED } from '../remote-model-name-check';
import { sealUserCredential } from '../../remote-providers/remote-provider.identity';
import { remoteProviderId } from '../../remote-providers/remote-provider.identity';
import { sealModelCredential } from '../remote-model-secret';
import type { IRemoteConnectionRow } from '../remote-connection.repository';

const MODEL = { id: 'model-name-check', runtime: 'remote-openai' } as const;
const ACTOR = 'user@example.com';
const BASE_URL = 'https://api.example.com/v1';

interface IFakeListModels {
    names: string[] | null;
    calls: Array<{ baseUrl: string; credential?: string }>;
}

const listModelsFake = (names: string[] | null): IFakeListModels => {
    const calls: IFakeListModels['calls'] = [];
    return {
        names,
        calls,
        client: {
            listModels: async (baseUrl: string, credential?: string) => {
                calls.push({ baseUrl, credential });
                return names;
            },
        },
    };
};

/** Пул отдаёт строку личного ключа (если она есть в args) на SELECT user_credentials. */
function fakePool(personalKey?: string, providerId?: string): Pool {
    const provider = providerId ?? remoteProviderId(MODEL, { base_url: BASE_URL });
    const credential = personalKey ? sealUserCredential(personalKey, ACTOR, provider, 1) : undefined;
    const client = {
        query: async (sql: string) => {
            if (sql.includes('remote_provider_user_credentials'))
                return { rows: credential ? [{ credential, revision: 1 }] : [] };
            return { rows: [] };
        },
        release: () => {},
    };
    return { connect: async () => client } as unknown as Pool;
}

const head = (overrides: Partial<IRemoteConnectionRow> = {}): IRemoteConnectionRow =>
    ({
        model_id: MODEL.id,
        revision: 1,
        base_url: BASE_URL,
        auth_mode: 'required',
        credential_kind: 'none',
        credential: null,
        credential_env: null,
        request_dimensions: false,
        options: {},
        timeout_ms: 90000,
        semantic_sha: null,
        verified_at: null,
        failure_message: null,
        revoked_at: null,
        ...overrides,
    }) as IRemoteConnectionRow;

describe('8.18: checkRemoteModelName — сверка имени модели со списком шлюза', () => {
    beforeAll(() => vi.stubEnv('NEUROCENTER_MODEL_CREDENTIAL_KEY', Buffer.alloc(32, 7).toString('base64')));
    afterAll(() => vi.unstubAllEnvs());
    beforeEach(() => vi.restoreAllMocks());

    it("authMode 'none' — проверка не выполняется, запросов к шлюзу нет", async () => {
        const fake = listModelsFake(['gpt-4o']);
        const result = await checkRemoteModelName({
            pool: fakePool(),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'none',
            actor: ACTOR,
        });
        expect(result).toEqual({});
        expect(fake.calls).toHaveLength(0);
    });

    it('имя в списке шлюза — сохранение без предупреждения', async () => {
        const fake = listModelsFake(['gpt-4o', 'gpt-4o-mini']);
        const result = await checkRemoteModelName({
            pool: fakePool('personal-key'),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o-mini',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
        });
        expect(result).toEqual({});
        expect(fake.calls).toHaveLength(1);
        expect(fake.calls[0].baseUrl).toBe(BASE_URL);
        expect(fake.calls[0].credential).toBe('personal-key');
    });

    it('имя не в списке — fail-closed ошибка со списком доступных имён', async () => {
        const fake = listModelsFake(['gpt-4o']);
        await expect(
            checkRemoteModelName({
                pool: fakePool(),
                client: fake.client,
                model: MODEL,
                modelName: 'claude-3',
                baseUrl: BASE_URL,
                authMode: 'required',
                actor: ACTOR,
            }),
        ).rejects.toMatchObject({
            status: 400,
            response: { code: 'REMOTE_MODEL_NAME_MISMATCH', modelName: 'claude-3', availableModels: ['gpt-4o'] },
        });
    });

    it('список недоступен (null) — деградация: предупреждение, не ошибка', async () => {
        const fake = listModelsFake(null);
        const result = await checkRemoteModelName({
            pool: fakePool(),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
        });
        expect(result).toEqual({ warning: REMOTE_MODEL_NAME_UNVERIFIED });
    });

    it('явный пустой список работающего шлюза — несовпадение, а не деградация', async () => {
        const fake = listModelsFake([]);
        await expect(
            checkRemoteModelName({
                pool: fakePool(),
                client: fake.client,
                model: MODEL,
                modelName: 'gpt-4o',
                baseUrl: BASE_URL,
                authMode: 'required',
                actor: ACTOR,
            }),
        ).rejects.toThrow(BadRequestException);
    });

    it('нет личного ключа — использует legacy-ключ подключения (credential_kind stored)', async () => {
        const fake = listModelsFake(['gpt-4o']);
        const headRow = head({
            credential_kind: 'stored',
            credential: sealModelCredential('legacy-key', MODEL.id, 1),
        });
        const result = await checkRemoteModelName({
            pool: fakePool(undefined, remoteProviderId(MODEL, { base_url: BASE_URL })),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
            head: headRow,
        });
        expect(result).toEqual({});
        expect(fake.calls[0].credential).toBe('legacy-key');
    });

    it('revoked head без личного ключа — запрос без ключа, не деградация', async () => {
        const fake = listModelsFake(['gpt-4o']);
        const result = await checkRemoteModelName({
            pool: fakePool(),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'optional',
            actor: ACTOR,
            head: head({ revoked_at: new Date().toISOString(), credential_kind: 'stored', credential: {} }),
        });
        expect(result).toEqual({});
        expect(fake.calls[0].credential).toBeUndefined();
    });

    it('legacy environment-ключ берётся из process.env', async () => {
        const fake = listModelsFake(['gpt-4o']);
        vi.stubEnv('NC_TEST_LEGACY_KEY', 'env-key');
        const result = await checkRemoteModelName({
            pool: fakePool(),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
            head: head({ credential_kind: 'environment', credential_env: 'NC_TEST_LEGACY_KEY' }),
        });
        expect(result).toEqual({});
        expect(fake.calls[0].credential).toBe('env-key');
    });

    it('сбой чтения личного ключа из БД — деградация на legacy-ключ, не ошибка', async () => {
        const fake = listModelsFake(['gpt-4o']);
        const pool = {
            connect: async () => ({
                query: async () => {
                    throw new Error('db down');
                },
                release: () => {},
            }),
        } as unknown as Pool;
        const result = await checkRemoteModelName({
            pool,
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
            head: head({
                credential_kind: 'stored',
                credential: sealModelCredential('legacy-key', MODEL.id, 1),
            }),
        });
        expect(result).toEqual({});
        expect(fake.calls[0].credential).toBe('legacy-key');
    });

    it('нечитаемый legacy-секрет — деградация (нет ключа), не ошибка', async () => {
        const fake = listModelsFake(['gpt-4o']);
        const result = await checkRemoteModelName({
            pool: fakePool(),
            client: fake.client,
            model: MODEL,
            modelName: 'gpt-4o',
            baseUrl: BASE_URL,
            authMode: 'required',
            actor: ACTOR,
            head: head({ credential_kind: 'stored', credential: { data: 'corrupted' } }),
        });
        // listModels без ключа на публичном API возвращает список — проверка проходит;
        // нечитаемый секрет не должен бросать исключение.
        expect(result.warning).toBeUndefined();
        expect(fake.calls[0].credential).toBeUndefined();
    });
});
