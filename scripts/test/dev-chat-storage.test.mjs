import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareDevChatStorage} from '../workspace/dev-chat-storage.mjs';

const ready = async () => ({ok: true});
const external = {CHAT_S3_ENDPOINT: 'https://ceph.example.test', CHAT_S3_PROJECT_BUCKET: 'project-chat', CHAT_S3_PERSONAL_BUCKET: 'personal-chat',
    CHAT_S3_ACCESS_KEY_FILE: 'secrets/access', CHAT_S3_SECRET_KEY_FILE: 'secrets/secret'};

test('External Ceph stays external, resolves secret paths, and rejects partial configuration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-external-'));
    try {
        await fs.mkdir(path.join(root, 'secrets')); await fs.writeFile(path.join(root, 'secrets/access'), 'test-access', {mode: 0o600}); await fs.writeFile(path.join(root, 'secrets/secret'), 'test-secret', {mode: 0o600});
        let probed = false;
        const result = await prepareDevChatStorage(root, external, {run() {throw Error('Must not start Docker');}, probe: async config => {assert.equal(config.secretKey, 'test-secret'); probed = true;}});
        assert.equal(result.CHAT_S3_ACCESS_KEY_FILE, path.join(root, 'secrets/access')); assert.ok(probed);
        assert.equal(result.CHAT_S3_ENDPOINT, external.CHAT_S3_ENDPOINT);
        await assert.rejects(prepareDevChatStorage(root, {CHAT_S3_ENDPOINT: external.CHAT_S3_ENDPOINT}), /CHAT_S3_ACCESS_KEY/);
        await assert.rejects(prepareDevChatStorage(root, {...external, CHAT_S3_ACCESS_KEY: 'inline-value'}), /только CHAT_S3_ACCESS_KEY_FILE/);
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

test('Local S3 reuses private credentials across restarts and never exposes them in Docker arguments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-store-'));
    try {
        const calls = [], run = (command, args, options) => {calls.push({command, args, options}); return {status: 0, stdout: args[0] === 'volume' ? '' : undefined};};
        const a = await prepareDevChatStorage(root, {}, {run, fetch: ready, probe: async () => {}});
        const before = await fs.readFile(a.CHAT_S3_SECRET_KEY_FILE);
        const b = await prepareDevChatStorage(root, {}, {run, fetch: ready, probe: async () => {}});
        assert.deepEqual(b, a); assert.deepEqual(await fs.readFile(b.CHAT_S3_SECRET_KEY_FILE), before);
        assert.equal((await fs.stat(a.CHAT_S3_SECRET_KEY_FILE)).mode & 0o777, 0o600);
        assert.equal(a.CHAT_S3_ENDPOINT, 'http://127.0.0.1:19010');
        assert.deepEqual(calls[0].args.slice(0, 2), ['volume', 'ls']);
        assert.equal(calls[0].options.encoding, 'utf8');
        assert.ok(calls.every(call => !JSON.stringify(call.args).includes(before.toString().trim())));
        assert.equal(calls.filter(call => call.args[0] === 'compose').length, 2);
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

test('Missing original credentials beside an existing volume fail without replacing identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-store-'));
    try {
        await assert.rejects(prepareDevChatStorage(root, {}, {run: (_command, args) => ({status: 0, stdout: args[args.indexOf('--filter') + 1].slice('name='.length) + '\n'}), fetch: ready}), /Ключи.*потеряны/);
        await assert.rejects(fs.stat(path.join(root, '.run/chat-storage/access-key')), {code: 'ENOENT'});
        await assert.rejects(prepareDevChatStorage(root, {CHAT_DEV_S3_PORT: 'NaN'}), /CHAT_DEV_S3_PORT/);
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

test('A failed S3 launch reports failure before old application services are stopped', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-store-'));
    try {
        await assert.rejects(prepareDevChatStorage(root, {}, {run: (_command, args) => ({status: args[0] === 'volume' ? 0 : 1, stdout: ''}), fetch: ready}), /прежние сервисы сохранены/);
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

for (const [name, result] of [
    ['timeout', {status: null, error: Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'})}],
    ['permission', {status: 1, stderr: 'permission denied'}],
    ['daemon', {status: 1, stderr: 'cannot connect to daemon'}],
    ['nonzero', {status: 2, stdout: ''}],
    ['signal', {status: null, signal: 'SIGTERM'}],
    ['missing-output', {status: 0}],
    ['malformed-output', {status: 0, stdout: 'unverified volume output'}],
]) test(`Uncertain Docker volume probe (${name}) never creates replacement credentials`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-store-probe-'));
    try {
        let failure;
        try {await prepareDevChatStorage(root, {}, {run: (_command, args) => args[0] === 'volume' ? result : {status: 1}, fetch: ready, probe: async () => {}});}
        catch (error) {failure = error;}
        for (const name of ['access-key', 'secret-key']) await assert.rejects(fs.stat(path.join(root, '.run/chat-storage', name)), {code: 'ENOENT'});
        assert.match(failure?.message || '', /Не удалось проверить.*Docker/);
    } finally {await fs.rm(root, {recursive: true, force: true});}
});

test('A partial credential pair never gets completed implicitly even with proven absent volume', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-chat-store-partial-'));
    try {
        const directory = path.join(root, '.run/chat-storage'); await fs.mkdir(directory, {recursive: true});
        const original = 'neurocenter-original-access\n'; await fs.writeFile(path.join(directory, 'access-key'), original, {mode: 0o600});
        await assert.rejects(prepareDevChatStorage(root, {}, {run: () => ({status: 0, stdout: ''}), fetch: ready, probe: async () => {}}), /Ключи.*потеряны/);
        assert.equal(await fs.readFile(path.join(directory, 'access-key'), 'utf8'), original);
        await assert.rejects(fs.stat(path.join(directory, 'secret-key')), {code: 'ENOENT'});
    } finally {await fs.rm(root, {recursive: true, force: true});}
});
