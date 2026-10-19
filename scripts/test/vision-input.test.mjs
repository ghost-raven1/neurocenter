import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile, symlink, mkdir, open, appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readImageInput, visionQuestion, MAX_IMAGE_BYTES, DEFAULT_VISION_QUESTION} from '../vision/image-input.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const webp = Buffer.from('524946460c000000574542505650382000000000', 'hex');
const cli = fileURLToPath(new URL('../vision/describe.mjs', import.meta.url));

async function fixture(action) {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-vision-input-'));
    try {await action(root);}
    finally {await rm(root, {recursive: true, force: true});}
}

for (const [name, bytes, mimeType] of [['PNG', png, 'image/png'], ['JPEG', jpeg, 'image/jpeg'], ['WebP', webp, 'image/webp']]) {
    test(`${name} определяется по содержимому файла с чужим расширением`, async () => fixture(async root => {
        const file = path.join(root, 'изображение с пробелом.txt'); await writeFile(file, bytes);
        const result = await readImageInput(file);
        assert.equal(result.mimeType, mimeType); assert.deepEqual(result.image, bytes);
    }));
}

test('Неверные и обрезанные сигнатуры не принимаются по расширению PNG', async () => fixture(async root => {
    const file = path.join(root, 'fake.png');
    const highBits = Buffer.from(webp); highBits[0] |= 0x80;
    for (const content of [Buffer.from('not an image'), png.subarray(0, 7), jpeg.subarray(0, 2), webp.subarray(0, 11), Buffer.from('RIFFabcdWAVE'), highBits]) {
        await writeFile(file, content); await assert.rejects(readImageInput(file), /PNG, JPEG и WebP/);
    }
}));

test('Пустой файл и файл больше 10 МиБ отклоняются до чтения содержимого', async () => fixture(async root => {
    const file = path.join(root, 'size.png'); await writeFile(file, '');
    await assert.rejects(readImageInput(file), /больше нуля/);
    const handle = await open(file, 'w'); await handle.truncate(MAX_IMAGE_BYTES + 1); await handle.close();
    await assert.rejects(readImageInput(file), /10 МиБ/);
}));

test('Файл ровно 10 МиБ остаётся допустимым', async () => fixture(async root => {
    const image = Buffer.alloc(MAX_IMAGE_BYTES); png.copy(image);
    const file = path.join(root, 'boundary.png'); await writeFile(file, image);
    const value = await readImageInput(file); assert.equal(value.image.length, MAX_IMAGE_BYTES); assert.equal(value.mimeType, 'image/png');
}));

test('Рост файла после stat ограничивает фактическое чтение лимитом плюс один байт', async t => fixture(async root => {
    const file = path.join(root, 'growing.png'); await writeFile(file, png);
    const probe = await open(file, 'r'); const prototype = Object.getPrototypeOf(probe); const read = prototype.read; await probe.close();
    let grown = false, received = 0;
    t.mock.method(prototype, 'read', async function (...args) {
        if (!grown) {grown = true; await appendFile(file, Buffer.alloc(MAX_IMAGE_BYTES + 64));}
        const value = await read.apply(this, args); received += value.bytesRead; return value;
    });
    await assert.rejects(readImageInput(file), /10 МиБ/);
    assert.equal(received, MAX_IMAGE_BYTES + 1);
}));

test('Изменение небольшого файла при чтении не выдаётся за согласованную картинку', async t => fixture(async root => {
    const file = path.join(root, 'changing.png'); await writeFile(file, png);
    const probe = await open(file, 'r'); const prototype = Object.getPrototypeOf(probe); const read = prototype.read; await probe.close();
    let changed = false;
    t.mock.method(prototype, 'read', async function (...args) {
        if (!changed) {changed = true; await appendFile(file, Buffer.from('changed'));}
        return read.apply(this, args);
    });
    await assert.rejects(readImageInput(file), /изменился/);
}));

test('Каталог и симлинк на изображение отклоняются, исходный файл сохраняется', async () => fixture(async root => {
    const file = path.join(root, 'source.png'); await writeFile(file, png);
    await mkdir(path.join(root, 'folder'));
    await assert.rejects(readImageInput(path.join(root, 'folder')), /обычным файлом/);
    await symlink(file, path.join(root, 'link.png'));
    await assert.rejects(readImageInput(path.join(root, 'link.png')), /символической ссылки/);
    assert.deepEqual(await readFile(file), png);
}));

test('Настоящий FIFO отклоняется без открытия и зависания', {skip: process.platform === 'win32'}, async () => fixture(async root => {
    const file = path.join(root, 'pipe.png');
    assert.equal(spawnSync('mkfifo', [file]).status, 0);
    await assert.rejects(readImageInput(file), /обычным файлом/);
}));

test('Ошибочные пути и URL не принимаются за локальные файлы', async () => fixture(async root => {
    for (const file of ['', '   ', null, {}, 'x\0.png', 'x\n.png', 'https://example.test/image.png', 'file:///tmp/image.png']) {
        await assert.rejects(readImageInput(file), /локальный путь/);
    }
    await assert.rejects(readImageInput(path.join(root, 'missing.png')), /не найден/);
}));

test('Вопрос по умолчанию и явный вопрос сохраняют UTF-8 и допустимую длину', () => {
    assert.equal(visionQuestion(), DEFAULT_VISION_QUESTION);
    assert.equal(visionQuestion('  Прочитай текст 日本語  '), 'Прочитай текст 日本語');
    assert.equal(visionQuestion('я'.repeat(4000)).length, 4000);
    for (const question of ['', '   ', null, 42, {}, 'я'.repeat(4001), 'text\0text']) assert.throws(() => visionQuestion(question), /1 до 4000/);
});

test('Справка CLI работает без Docker, модели и корректного runtime-порта', () => {
    const result = spawnSync(process.execPath, [cli, '--help'], {encoding: 'utf8', env: {...process.env, EMBEDDING_PORT: 'invalid'}});
    assert.equal(result.status, 0); assert.match(result.stdout, /vision:describe/); assert.match(result.stdout, /не запускает и не скачивает/); assert.equal(result.stderr, '');
});

test('Ошибки аргументов CLI возвращают короткое сообщение и код 1', async () => fixture(async root => {
    const file = path.join(root, 'own.png'); await writeFile(file, png);
    for (const args of [[], ['--unknown'], [file, ''], [file, 'x'.repeat(4001)], [file, 'question', 'extra'], [path.join(root, 'missing.png')]]) {
        const result = spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...process.env, EMBEDDING_PORT: 'invalid'}});
        assert.equal(result.status, 1); assert.ok(result.stderr.trim()); assert.doesNotMatch(result.stderr, /\n\s+at |ERR_MODULE_NOT_FOUND|EMBEDDING_PORT/);
    }
}));

async function isolatedCli(root) {
    const target = new URL('../vision/describe.mjs', import.meta.url).href;
    await writeFile(path.join(root, 'hook.mjs'), `import {registerHooks} from 'node:module';
        registerHooks({resolve(specifier, context, next) {
            if (context.parentURL === ${JSON.stringify(target)} && ['./client.mjs', '../embedding/config.mjs'].includes(specifier)) {
                return {url: new URL(specifier === './client.mjs' ? './client.mjs' : './config.mjs', import.meta.url).href, shortCircuit: true};
            }
            return next(specifier, context);
        }});`);
    await writeFile(path.join(root, 'config.mjs'), 'export function configuration(env, root, kind) {return {kind, rootWasUndefined: root === undefined};}');
    await writeFile(path.join(root, 'client.mjs'), `import {writeFile} from 'node:fs/promises';
        export async function visionChat(config, {image, mimeType, question}) {
            if (process.env.VISION_INPUT_TEST_FAIL) throw Error('Локальная модель недоступна. Выполните vision:up.');
            await writeFile(process.env.VISION_INPUT_TEST_RECEIPT, JSON.stringify({config, mimeType, question, bytes: image.length}));
            return {model: 'own-fixture', text: 'Тестовая картинка 日本語', truncated: process.env.VISION_INPUT_TEST_TRUNCATED === '1'};
        }`);
    await writeFile(path.join(root, 'own.png'), png);
    const receipt = path.join(root, 'received.json');
    return {receipt, run: (args, env = {}) => spawnSync(process.execPath, ['--import', path.join(root, 'hook.mjs'), cli, ...args],
        {cwd: root, encoding: 'utf8', env: {...process.env, EMBEDDING_PORT: 'invalid', VISION_INPUT_TEST_RECEIPT: receipt, ...env}})};
}

test('CLI передаёт относительный файл и вопрос по умолчанию, печатает ответ UTF-8 без заголовков', async () => fixture(async root => {
    const cli = await isolatedCli(root); const result = cli.run(['own.png']);
    assert.equal(result.status, 0); assert.equal(result.stdout, 'Тестовая картинка 日本語\n'); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(await readFile(cli.receipt, 'utf8')),
        {config: {kind: 'vision', rootWasUndefined: true}, mimeType: 'image/png', question: DEFAULT_VISION_QUESTION, bytes: png.length});
}));

test('CLI сохраняет явный вопрос и сообщает об усечённом ответе отдельно от текста', async () => fixture(async root => {
    const cli = await isolatedCli(root); const result = cli.run(['own.png', 'Прочитай 日本語'], {VISION_INPUT_TEST_TRUNCATED: '1'});
    assert.equal(result.status, 0); assert.equal(result.stdout, 'Тестовая картинка 日本語\n'); assert.match(result.stderr, /Ответ сокращён/);
    assert.equal(JSON.parse(await readFile(cli.receipt, 'utf8')).question, 'Прочитай 日本語');
}));

test('Отказ vision-клиента возвращается в CLI одной строкой без стека и автоматического запуска', async () => fixture(async root => {
    const cli = await isolatedCli(root); const result = cli.run(['own.png'], {VISION_INPUT_TEST_FAIL: '1'});
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Локальная модель недоступна. Выполните vision:up.\n');
}));
