import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture } from './bridge-fixture.js';
import { rehashPackage, setPackage } from './install-set-fixture.js';
import { install } from '../src/bridge/installer.js';
import { writeState } from '../src/bridge/state.js';
import { configurationContext } from '../src/features/local-configuration/context.js';
import { projectLocalEmbeddingFields } from '../src/features/local-configuration/project-local-embedding.js';
import { openMcpConfiguration, prepareMcpConfiguration, readMcpConfiguration } from '../src/features/local-configuration/index.js';
import { closeConfigurationSessions } from '../src/features/local-configuration/server.js';
import { saveConfiguration } from '../src/features/local-configuration/state.js';
import type { LocalConfigurationSchema } from '../src/features/local-configuration/schema.js';

const noop = async () => {};
const ragSchema = (): LocalConfigurationSchema => ({schemaVersion: 1, fields: [
    {id: 'serviceUrl', label: 'URL', type: 'url', required: true, target: {kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_URL'}},
    {id: 'modelName', label: 'Модель', type: 'string', required: true, target: {kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_MODEL'}},
    {id: 'protocol', label: 'Протокол', type: 'string', required: false, target: {kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_PROVIDER'}},
    {id: 'apiKey', label: 'Ключ', type: 'string', required: false, secret: true, target: {kind: 'env', name: 'NEUROCENTER_RAG_EMBEDDING_KEY'}},
]});

describe('Профиль локальных эмбеддингов в мастере MCP', () => {
    it('распознаёт назначение env-полей независимо от названия MCP и ID полей', () => {
        expect(projectLocalEmbeddingFields(ragSchema())).toEqual({url: 'serviceUrl', model: 'modelName', provider: 'protocol'});
    });
    it('не передаёт ключ, значения, env-имена и схему в метаданных профиля', () => {
        expect(Object.keys(projectLocalEmbeddingFields(ragSchema())!)).toEqual(['url', 'model', 'provider']);
    });
    it.each([0, 1, 2])('не предлагает профиль без обязательного назначения №%s', index => {
        const schema = ragSchema(); schema.fields.splice(index, 1);
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
    it.each([0, 1, 2])('не предлагает профиль с секретным полем №%s', index => {
        const schema = ragSchema(); schema.fields[index]!.secret = true;
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
    it.each([0, 1, 2])('не предлагает профиль с другим типом поля №%s', index => {
        const schema = ragSchema(); schema.fields[index]!.type = 'number';
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
    it('не меняет форму другого MCP с похожими идентификаторами', () => {
        const schema = ragSchema(); for (const field of schema.fields) {field.target.name = 'OTHER_' + field.id;}
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
    it('не предлагает env-профиль для заголовков удалённого MCP', () => {
        const schema = ragSchema(); for (const field of schema.fields) {field.target.kind = 'header';}
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
    it('не предлагает профиль при префиксе, меняющем передаваемое значение', () => {
        const schema = ragSchema(); schema.fields[0]!.target.prefix = 'https://';
        expect(projectLocalEmbeddingFields(schema)).toBeUndefined();
    });
});

describe('Локальный HTTP-мастер с профилем эмбеддингов', () => {
    let temporary = '';
    beforeEach(async () => {
        ({temporary} = await workspaceFixture());
        await writeState('credentials', {deviceId: 'own-fixture', token: 'fixture-only', email: 'fixture@example.test'});
    });
    afterEach(async () => {closeConfigurationSessions(); vi.unstubAllEnvs(); await fs.rm(temporary, {recursive: true, force: true});});

    async function session(rag: boolean) {
        const pkg = setPackage('own-fixture'); pkg.schemaVersion = 5;
        const schema = ragSchema(); if (!rag) {schema.fields = [schema.fields[3]!];}
        pkg.config = {...pkg.config, extra: {localConfiguration: schema}}; rehashPackage(pkg);
        await install('test-project', pkg, noop, noop);
        const context = await configurationContext('test-project', pkg, undefined, noop);
        await saveConfiguration(context, {apiKey: 'OWN_FIXTURE_PRESERVED_KEY'}, null, noop);
        const prepared = await prepareMcpConfiguration('test-project', pkg, undefined, noop); let localUrl = '';
        await openMcpConfiguration('test-project', pkg, undefined, {...prepared, open: async url => {localUrl = url; return true;}}, noop);
        const url = new URL(localUrl);
        const post = (route: string, input: unknown, csrf = '') => fetch(url.origin + route, {method: 'POST',
            headers: {Origin: url.origin, 'Content-Type': 'application/json', 'X-Configuration-CSRF': csrf}, body: JSON.stringify(input)});
        const response = await post('/session', {token: url.hash.slice(1)}); expect(response.status).toBe(200);
        return {pkg, post, form: await response.json() as {csrf: string; revision: string; projectLocalEmbeddingFields?: unknown}};
    }

    it('выдаёт только ID полей и сохраняет прежний ключ при явном сохранении профиля', async () => {
        const {pkg, post, form} = await session(true);
        expect(form.projectLocalEmbeddingFields).toEqual({url: 'serviceUrl', model: 'modelName', provider: 'protocol'});
        expect(JSON.stringify(form)).not.toContain('OWN_FIXTURE_PRESERVED_KEY');
        expect(JSON.stringify(form)).not.toContain('NEUROCENTER_RAG_EMBEDDING_');
        const saved = await post('/save', {updates: {serviceUrl: 'http://127.0.0.1:11435/api', modelName: 'qwen3-embedding:4b', protocol: 'ollama'},
            remove: [], expectedRevision: form.revision}, form.csrf);
        expect(saved.status).toBe(200);
        const local = await readMcpConfiguration('test-project', pkg, undefined, noop);
        expect(local.env).toEqual({NEUROCENTER_RAG_EMBEDDING_URL: 'http://127.0.0.1:11435/api', NEUROCENTER_RAG_EMBEDDING_MODEL: 'qwen3-embedding:4b',
            NEUROCENTER_RAG_EMBEDDING_PROVIDER: 'ollama', NEUROCENTER_RAG_EMBEDDING_KEY: 'OWN_FIXTURE_PRESERVED_KEY'});
    });
    it('не добавляет метаданные профиля в мастер другого MCP', async () => {
        const {form} = await session(false);
        expect(Object.hasOwn(form, 'projectLocalEmbeddingFields')).toBe(false);
    });
});
