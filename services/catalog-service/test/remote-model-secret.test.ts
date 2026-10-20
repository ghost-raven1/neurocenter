import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canStoreModelCredential, openModelCredential, sealModelCredential } from '../src/models/remote-model-secret';

const environment = { NEUROCENTER_MODEL_CREDENTIAL_KEY: randomBytes(32).toString('base64') };

describe('Приватный ключ удалённой модели', () => {
    it('Шифрует независимо каждую запись и открывает только правильную модель и ревизию', () => {
        const first = sealModelCredential('fixture-provider-key', 'model-first', 1, environment);
        const second = sealModelCredential('fixture-provider-key', 'model-first', 1, environment);
        expect(JSON.stringify(first)).not.toContain('fixture-provider-key'); expect(first.nonce).not.toBe(second.nonce);
        expect(openModelCredential(first, 'model-first', 1, environment)).toBe('fixture-provider-key');
        expect(() => openModelCredential(first, 'model-second', 1, environment)).toThrow('Не удалось открыть');
        expect(() => openModelCredential(first, 'model-first', 2, environment)).toThrow('Не удалось открыть');
    });
    it('Не подменяет отсутствующий master key внутренним auth token или plaintext', () => {
        expect(canStoreModelCredential({ NEUROCENTER_INTERNAL_TOKEN: 'a'.repeat(64) })).toBe(false);
        expect(() => sealModelCredential('fixture-provider-key', 'model-first', 1, {})).toThrow('NEUROCENTER_MODEL_CREDENTIAL_KEY');
        expect(canStoreModelCredential(environment)).toBe(true);
    });
    it.each(['data', 'tag', 'nonce', 'keyId'] as const)('Не принимает повреждённое поле %s и не раскрывает исходный секрет', field => {
        const sealed = sealModelCredential('fixture-provider-key', 'model-first', 1, environment);
        const failure = (() => { try { openModelCredential({ ...sealed, [field]: 'bad' }, 'model-first', 1, environment); } catch (error) { return error as Error; } })();
        expect(failure?.message).toContain('Не удалось открыть'); expect(failure?.message).not.toContain('fixture-provider-key');
    });
    it('Смена master key требует явной миграции, не выдаёт старые bytes за новый ключ', () => {
        const sealed = sealModelCredential('fixture-provider-key', 'model-first', 1, environment);
        expect(() => openModelCredential(sealed, 'model-first', 1, { NEUROCENTER_MODEL_CREDENTIAL_KEY: randomBytes(32).toString('base64') })).toThrow('Не удалось открыть');
    });
});
