import { describe, expect, it } from 'vitest';
import { validateModelCreate, validateModelDescriptor } from '../src/models/model-validation';
import { remoteConnectionInput, remoteModelBaseUrl, remoteVerificationDigest } from '../src/models/remote-model-validation';
import type { IModel } from '../src/models/model.types';
import { assertRemoteModelOptions, remoteModelOptions } from '../src/models/remote-model-options';

const input = { name: 'API модели', capability: 'embedding', runtime: 'remote-openai', model: 'text-embedding-example', modelVersion: '2026-10', dimension: 1536 };
const descriptor = { description: '', capability: 'embedding', runtime: 'remote-openai', model: input.model, modelVersion: input.modelVersion,
    dimension: 1536, manifestSha256: null, verificationSha256: null, source: 'custom' };
const model = { ...descriptor, id: 'model-example', name: input.name, revision: 1, createdAt: '', updatedAt: '' } as IModel;

describe('Контракт удалённой модели без адреса и секретов в карточке', () => {
    it.each(['remote-openai', 'remote-ollama'])('Принимает %s и нативный public descriptor без подключения чужой площадки', runtime => {
        expect(validateModelCreate({ ...input, runtime })).toMatchObject({ runtime, modelVersion: '2026-10', dimension: 1536 });
        expect(validateModelDescriptor({ ...descriptor, runtime })).toEqual({ ...descriptor, runtime });
    });
    it.each([{ modelVersion: undefined }, { modelVersion: '' }, { modelVersion: 'a\n' }, { model: 'https://example.test/model' },
        { runtime: 'remote' }, { baseUrl: 'https://example.test' }, { apiKey: 'secret' }, { verificationSha256: 'a'.repeat(64) }])('Отклоняет неоднозначную идентичность и подмену приватной настройки: %j', patch => {
        expect(() => validateModelCreate({ ...input, ...patch })).toThrow();
    });
    it.each([{ manifestSha256: 'a'.repeat(64) }, { verificationSha256: 'a'.repeat(64) }, { baseUrl: 'https://example.test' }, { apiKey: 'secret' }])('Public asset не содержит чужой probe или секрет: %j', patch => {
        expect(() => validateModelDescriptor({ ...descriptor, ...patch })).toThrow();
    });
    it('Семантический digest меняется с endpoint/model version/размерностью, но не с ключом и ревизией доступа', () => {
        const connection = { modelId: model.id, revision: 1, baseUrl: 'https://api.example.test/v1', requestDimensions: false, apiKey: 'first' };
        const first = remoteVerificationDigest(model, connection, 1536);
        expect(remoteVerificationDigest(model, { ...connection, apiKey: 'second', revision: 2 }, 1536)).toBe(first);
        expect(remoteVerificationDigest(model, { ...connection, baseUrl: 'https://other.example.test/v1' }, 1536)).not.toBe(first);
        expect(remoteVerificationDigest({ ...model, modelVersion: '2027' }, connection, 1536)).not.toBe(first);
        expect(remoteVerificationDigest(model, connection, 2560)).not.toBe(first);
        expect(remoteVerificationDigest(model, { ...connection, options: {}, timeoutMs: 300000 }, 1536)).toBe(first);
        const configured = { ...connection, options: { temperature: 0.3, topP: 0.8 } };
        expect(remoteVerificationDigest(model, configured, 1536)).not.toBe(first);
        expect(remoteVerificationDigest(model, { ...connection, options: { topP: 0.8, temperature: 0.3 } }, 1536)).toBe(remoteVerificationDigest(model, configured, 1536));
    });
    it('Оставляет параметры пустыми по умолчанию, отдельно ограничивая transport timeout', () => {
        const base = { expectedRevision: 0, expectedModelRevision: 1, baseUrl: 'https://api.example.test/v1', requestDimensions: false, credential: 'none' };
        expect(remoteConnectionInput(base)).toMatchObject({ options: {}, timeoutMs: 90000 });
        expect(remoteConnectionInput({ ...base, options: { temperature: 0, topP: 1, maxOutputTokens: 32768, contextWindow: 2097152 }, timeoutMs: 300000 })).toMatchObject({ timeoutMs: 300000 });
        for (const timeoutMs of [null, 999, 300001, 1500.5, '90000']) expect(() => remoteConnectionInput({ ...base, timeoutMs })).toThrow('Таймаут');
    });
    it.each([null, [], { apiKey: 'secret' }, { temperature: null }, { temperature: 2.01 }, { topP: -0.1 }, { topP: Infinity },
        { maxOutputTokens: 0 }, { maxOutputTokens: 1.5 }, { maxOutputTokens: 32769 }, { contextWindow: 127 }, { contextWindow: 2097153 }])('Отклоняет неразрешённые generation options: %j', value => {
        expect(() => remoteModelOptions(value)).toThrow();
    });
    it('Отклоняет embedding sampling, но принимает объявленный бюджет OpenAI и Ollama', () => {
        expect(() => assertRemoteModelOptions(model, { temperature: 0 })).toThrow('Embedding');
        expect(() => assertRemoteModelOptions({ runtime: 'remote-openai', capability: 'chat' }, { contextWindow: 4096 })).not.toThrow();
        expect(() => assertRemoteModelOptions({ runtime: 'remote-ollama', capability: 'vision' }, { contextWindow: 4096 })).not.toThrow();
    });
});

describe('Приватная настройка удалённого API', () => {
    const connection = { expectedRevision: 0, expectedModelRevision: 1, baseUrl: 'https://api.example.test/v1', requestDimensions: false };
    it.each([
        { name: 'массив none', credential: ['none'] }, { name: 'массив stored', credential: ['stored'] },
        { name: 'массив environment', credential: ['environment'] }, { name: 'null', credential: null },
        { name: 'undefined', credential: undefined }, { name: 'число', credential: 42 }, { name: 'boolean', credential: true },
        { name: 'объект String', credential: new String('none') },
        { name: 'объект с опасным coercion', credential: { toString: () => { throw new Error('Credential must not be coerced'); } } },
    ])('Возвращает 400 для способа авторизации другого типа: $name', ({ credential }) => {
        const result = (() => { try { remoteConnectionInput({ ...connection, credential }); } catch (error) { return error; } })();
        expect(result).toMatchObject({ status: 400 });
    });
    it.each([
        { credential: 'none' }, { credential: 'stored', apiKey: 'fixture-key' },
        { credential: 'environment', credentialEnv: 'NEUROCENTER_REMOTE_MODEL_PROVIDER' },
    ])('Сохраняет явный строковый режим авторизации $credential', value => {
        expect(remoteConnectionInput({ ...connection, ...value })).toMatchObject(value);
    });
    it('Разрешает явно выбранные self-hosted адреса и префикс API', () => {
        expect(remoteModelBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
        expect(remoteModelBaseUrl('https://models.example.test/openai/v1/')).toBe('https://models.example.test/openai/v1');
        expect(remoteModelBaseUrl('http://10.0.0.2:11434')).toBe('http://10.0.0.2:11434');
    });
    it.each(['file:///etc/passwd', 'https://user:password@example.test', 'https://example.test?api_key=secret', 'https://example.test/#fragment',
        'http://169.254.169.254', 'http://metadata.google.internal', 'http://[fe80::1]', 'http://0.0.0.0', 'http://224.0.0.1', 'https://example.test/%2e%2e/'])('Не разрешает служебный или неявный адрес %s', value => {
        expect(() => remoteModelBaseUrl(value)).toThrow();
    });
    it('Ограничивает env-ссылки ключами моделей и не принимает секрет одновременно с другим режимом', () => {
        const base = { expectedRevision: 0, expectedModelRevision: 1, baseUrl: 'https://api.example.test/v1', requestDimensions: false };
        expect(remoteConnectionInput({ ...base, credential: 'environment', credentialEnv: 'NEUROCENTER_REMOTE_MODEL_PROVIDER' })).toMatchObject({ credential: 'environment' });
        expect(() => remoteConnectionInput({ ...base, credential: 'environment', credentialEnv: 'CATALOG_PG_URL' })).toThrow();
        expect(() => remoteConnectionInput({ ...base, credential: 'none', apiKey: 'secret' })).toThrow();
        expect(() => remoteConnectionInput({ ...base, credential: 'stored', apiKey: 'secret\nheader' })).toThrow();
    });
});
