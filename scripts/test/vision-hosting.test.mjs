import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {configuration} from '../embedding/config.mjs';
import {verifiedReceipt,verifyModelFiles,withControlLock} from '../embedding/runtime.mjs';
import {visionRequest,visionResult} from '../vision/client.mjs';
import {visionFixture} from '../vision/image-fixture.mjs';

const config = configuration({}, '/tmp/vision-project', 'vision');
const input = {image: visionFixture(), question: 'Read the image.'};

test('Vision и embedding используют один runtime и отдельные манифесты и статусы', () => {
    const embedding = configuration({}, '/tmp/vision-project');
    assert.equal(config.project, embedding.project); assert.equal(config.data, embedding.data);
    assert.equal(config.baseUrl, embedding.baseUrl); assert.equal(config.lock.image, embedding.lock.image);
    assert.notEqual(config.manifest, embedding.manifest); assert.notEqual(config.receipt, embedding.receipt);
    assert.ok(config.manifest.endsWith('/qwen3-vl/2b-instruct'));
    assert.equal(config.upCommand, 'npm run vision:up');
    assert.throws(() => configuration({}, undefined, 'unknown'));
});

test('Embedding receipt не подтверждает vision, а отметка vision требует успешной проверки картинки', () => {
    const receipt = {model: config.lock.model, checkedAt: '2026-01-01T00:00:00.000Z', image: config.lock.image, manifestSha256: config.lock.manifestSha256};
    assert.equal(verifiedReceipt(config, {...receipt, dimension: 2560}), false);
    assert.equal(verifiedReceipt(config, {...receipt, capability: 'vision'}), false);
    assert.equal(verifiedReceipt(config, {...receipt, capability: 'vision', visionVerified: false}), false);
    assert.equal(verifiedReceipt(config, {...receipt, capability: 'vision', visionVerified: true}), true);
    const embedding = configuration();
    assert.equal(verifiedReceipt(embedding, {...receipt, model: embedding.lock.model, image: embedding.lock.image, manifestSha256: embedding.lock.manifestSha256, dimension: 2560}), true);
    for (const changed of [{model: undefined}, {model: 'other'}, {checkedAt: undefined}, {checkedAt: null}, {checkedAt: 'not-a-date'}, {checkedAt: '2999-01-01T00:00:00.000Z'}]) {
        assert.equal(verifiedReceipt(config, {...receipt, capability: 'vision', visionVerified: true, ...changed}), false);
    }
});

test('Native запрос передаёт PNG как base64 и ограничивает генерацию', () => {
    const request = visionRequest(config, input);
    assert.equal(request.url, 'http://127.0.0.1:11435/api/chat');
    assert.equal(request.body.model, config.lock.model); assert.equal(request.body.stream, false);
    assert.deepEqual(Buffer.from(request.body.messages[0].images[0], 'base64'), input.image);
    assert.equal(request.body.options.num_ctx, 4096); assert.equal(request.body.options.num_predict, 256);
    assert.equal(request.body.options.temperature, 0); assert.equal(request.timeout, 300000);
});

test('OpenAI получает data URL картинки, а не путь файла или внешний URL', () => {
    const request = visionRequest(config, {...input, protocol: 'openai'});
    assert.equal(request.url, 'http://127.0.0.1:11435/v1/chat/completions');
    const content = request.body.messages[0].content;
    assert.equal(content[0].text, input.question);
    assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'));
    assert.equal(request.body.max_tokens, 256);
});

test('Ввод и бюджеты проверяются до обращения к runtime', () => {
    for (const changed of [{image: 'http://example.org/private.png'}, {image: Buffer.alloc(0)}, {image: Buffer.alloc(10 * 1024 * 1024 + 1)},
        {mimeType: 'image/gif'}, {question: ''}, {question: 'x'.repeat(4001)}, {maxTokens: 0}, {maxTokens: 1025},
        {protocol: 'remote'}, {timeout: 0}, {timeout: 600001}]) assert.throws(() => visionRequest(config, {...input, ...changed}));
    assert.throws(() => visionRequest(configuration(), input));
});

test('Ответ требует завершённого текста и совпадения модели; усечение явно возвращается', () => {
    const valid = {model: config.lock.model, message: {content: ' A red square. '}, done: true, done_reason: 'stop'};
    assert.deepEqual(visionResult(valid, config.lock.model, 'ollama'), {model: config.lock.model, text: 'A red square.', truncated: false});
    assert.equal(visionResult({...valid, done_reason: 'length'}, config.lock.model, 'ollama').truncated, true);
    for (const changed of [{done: false}, {message: {content: ''}}, {message: {content: 'x'.repeat(32769)}}, {model: 'other'}, {model: undefined}, {model: null}, {model: ''}, {done_reason: 'load'}]) {
        assert.throws(() => visionResult({...valid, ...changed}, config.lock.model, 'ollama'));
    }
    const openai = {model: config.lock.model, choices: [{message: {content: 'Visible text.'}, finish_reason: 'stop'}]};
    assert.equal(visionResult(openai, config.lock.model, 'openai').text, 'Visible text.');
    for (const model of [undefined, null, '', false, 'other']) assert.throws(() => visionResult({...openai, model}, config.lock.model, 'openai'));
    openai.choices[0].finish_reason = null;
    assert.throws(() => visionResult(openai, config.lock.model, 'openai'));
});

test('SHA проверяет также vision projector, не только языковые веса', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-vision-cache-'));
    try {
        const current = configuration({}, root, 'vision');
        const blobs = [Buffer.from('config'), Buffer.from('language'), Buffer.from('projector')];
        const items = blobs.map(bytes => ({size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex')}));
        const manifest = JSON.stringify({config: items[0], layers: items.slice(1)});
        current.lock = {...current.lock, manifest: JSON.parse(manifest), manifestSha256: createHash('sha256').update(manifest).digest('hex')};
        await mkdir(path.dirname(current.manifest), {recursive: true});
        await mkdir(path.join(current.data, 'models/blobs'), {recursive: true});
        await writeFile(current.manifest, manifest);
        for (const [index, item] of items.entries()) await writeFile(path.join(current.data, 'models/blobs', item.digest.replace(':', '-')), blobs[index]);
        await verifyModelFiles(current);
        await writeFile(path.join(current.data, 'models/blobs', items[2].digest.replace(':', '-')), 'corrupted');
        await assert.rejects(verifyModelFiles(current), /SHA/);
    } finally {await rm(root, {recursive: true, force: true});}
});

test('Общая блокировка исключает одновременную подготовку vision и embedding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-vision-lock-'));
    try {
        await withControlLock(configuration({}, root, 'vision'), async () => {
            await assert.rejects(withControlLock(configuration({}, root), async () => {}), /уже выполняется/);
        });
        await withControlLock(configuration({}, root), async () => {});
    } finally {await rm(root, {recursive: true, force: true});}
});
