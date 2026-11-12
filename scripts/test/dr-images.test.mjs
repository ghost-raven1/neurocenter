import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applicationServices } from '../production/compose-client.mjs';
import { schemaServices } from '../production/schema-migrations.mjs';
import { buildReleaseManifest } from '../production/release-manifest.mjs';
import { digestFile } from '../production/recovery-files.mjs';
import {
    bundleEntries,
    bundleImages,
    downloadImageBundle,
    imageBundleFormat,
    loadImageBundle,
    readImageBundle,
    uploadImageBundle,
    validateImageBundle,
    verifyImageBundle,
} from '../production/dr-images.mjs';

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const image = (letter) => 'sha256:' + letter.repeat(64);
const serviceLetters = ['a', 'b', 'c', 'd', 'e', 'f', '0'];
const driftLetters = ['2', '3', '4', '5', '6', '7', '8'];
const serviceImages = () =>
    Object.fromEntries(applicationServices.map((service, index) => [service, image(serviceLetters[index])]));
const driftImages = () =>
    Object.fromEntries(applicationServices.map((service, index) => [service, image(driftLetters[index])]));
const POSTGRES = image('1');
const NODE_EXPORTER = 'sha256:' + '9a'.repeat(32);
const migrationRows = (service) =>
    service === 'rag-sync-service'
        ? [{ scope: 'data', version: 'project-generations-1', name: 'Поколения проектов', checksum: 'c'.repeat(64) }]
        : [
              { version: 0, name: 'Полная исходная схема', checksum: 'b'.repeat(64) },
              { version: 1, name: 'История установки', checksum: 'c'.repeat(64) },
          ];
const migrationManifests = () => Object.fromEntries(schemaServices.map((service) => [service, migrationRows(service)]));
const vendorContract = () => ({
    package: '@neurocenter/asset-contract',
    version: '1.2.1',
    commit: 'e'.repeat(40),
    sha256sums: { 'README.md': '9'.repeat(64), 'SOURCE.json': '8'.repeat(64) },
});
const supply = () => ({
    runtime: [],
    opencode: [],
    installers: [{ name: 'install.sh', sha256: 'b'.repeat(64) }],
    vendorContract: vendorContract(),
});
function makeManifest({
    commit = COMMIT,
    release = 'fixture-1',
    images = serviceImages(),
    postgresImage = POSTGRES,
    nodeExporterImage = NODE_EXPORTER,
} = {}) {
    return buildReleaseManifest({
        commit,
        release,
        images,
        postgresImage,
        nodeExporterImage,
        supply: supply(),
        migrations: migrationManifests(),
    });
}

/** Все 8 пар (svc -> imageId) бандла: 7 приложений + postgres, в порядке сборки. */
function allEntries(manifest) {
    return [
        ...applicationServices.map((service) => [service, manifest.images[service]]),
        ['postgres', manifest.postgresImage],
    ];
}

/** Детерминированные «tar»-байты на imageId; postgres — крупный (2 chunk'а EXTERNAL_CHUNK_BYTES). */
function makeTar(name, imageId, large) {
    if (large) {
        const buf = Buffer.alloc(32 * 1024 * 1024 + 1024);
        buf.fill(Buffer.from('dr-large:' + name + ':' + imageId + '\n'));
        return buf;
    }
    return Buffer.from('dr-tar ' + name + ' ' + imageId + '\n');
}
function makeRegistry(manifest) {
    const registry = new Map();
    for (const [name, imageId] of allEntries(manifest))
        registry.set(imageId, makeTar(name, imageId, name === 'postgres'));
    return registry;
}

async function tempDir(t, label) {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc dr-images ' + label + ' ')));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

/** Мок docker: save пишет tar по ID, load возвращает «Loaded image ID: …» (или кастомный вывод). */
function idForBytes(registry, bytes) {
    for (const [id, tar] of registry) if (tar.equals(bytes)) return id;
    return null;
}
function makeDocker({ registry, loadOutput, inspect }) {
    const calls = [];
    const run = async (args, options = {}) => {
        calls.push(args.slice());
        if (args[0] === 'save') {
            const tar = registry.get(args[1]);
            if (!tar) throw new Error('fixture docker: нет образа ' + args[1]);
            // Как реальный docker (createWriteStream 'wx'): существующий файл блокирует save.
            await writeFile(options.outputFile, tar, { flag: 'wx' });
            return '';
        }
        if (args[0] === 'load') {
            const bytes = await readFile(options.inputFile);
            if (loadOutput) return loadOutput(bytes);
            const id = idForBytes(registry, bytes);
            if (!id) throw new Error('fixture docker: неизвестный tar при load');
            return 'Loaded image ID: ' + id + '\n';
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
            const id = inspect ? inspect(args[2]) : 'sha256:' + '9'.repeat(64);
            return JSON.stringify([{ Id: id }]);
        }
        if (args[0] === 'tag') {
            if (args.length !== 3) throw new Error('fixture docker: некорректный tag');
            return '';
        }
        throw new Error('fixture docker: ' + args.join(' '));
    };
    return { run, calls };
}

/** In-memory S3-хранилище той же формы, что createExternalS3Store. */
function makeStore() {
    const objects = new Map();
    let privacyChecks = 0;
    return {
        objects,
        get privacyChecks() {
            return privacyChecks;
        },
        assertPrivate: async () => {
            privacyChecks += 1;
        },
        put: async (key, body) => {
            objects.set(key, Buffer.from(body));
        },
        get: async (key) => {
            const value = objects.get(key);
            if (!value) throw new Error('fixture store: нет объекта ' + key);
            return value;
        },
    };
}

test('validateImageBundle: валидная опись проходит, битые ключи/значения отклоняются', () => {
    const valid = {
        format: imageBundleFormat,
        bundleId: 'images-' + COMMIT.slice(0, 12),
        commit: COMMIT,
        release: 'fixture-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        images: Object.fromEntries(
            applicationServices.map((service) => [
                service,
                { imageId: image('a'), file: 'images/' + service + '.tar', sha256: '1'.repeat(64), size: 128 },
            ]),
        ),
        postgresImage: { imageId: POSTGRES, file: 'images/postgres.tar', sha256: '2'.repeat(64), size: 256 },
    };
    assert.equal(validateImageBundle(valid), valid);
    const cases = [
        [
            'посторонний ключ (секрет)',
            (value) => {
                value.token = 'x';
            },
        ],
        [
            'отсутствующий ключ',
            (value) => {
                delete value.createdAt;
            },
        ],
        [
            'format',
            (value) => {
                value.format = 'other-v1';
            },
        ],
        [
            'release latest',
            (value) => {
                value.release = 'latest';
            },
        ],
        [
            'commit',
            (value) => {
                value.commit = 'z'.repeat(39);
            },
        ],
        [
            'imageId',
            (value) => {
                value.images.frontend.imageId = 'sha256:zzz';
            },
        ],
        [
            'sha256',
            (value) => {
                value.images.frontend.sha256 = 'B'.repeat(64);
            },
        ],
        [
            'size',
            (value) => {
                value.images.frontend.size = 0;
            },
        ],
        [
            'file',
            (value) => {
                value.images.frontend.file = 'other.tar';
            },
        ],
        [
            'отсутствующий сервис',
            (value) => {
                delete value.images['api-gateway'];
            },
        ],
        [
            'лишний сервис',
            (value) => {
                value.images.postgres = value.postgresImage;
            },
        ],
        [
            'postgres file',
            (value) => {
                value.postgresImage.file = 'images/other.tar';
            },
        ],
    ];
    for (const [label, mutate] of cases) {
        const broken = structuredClone(valid);
        mutate(broken);
        assert.throws(() => validateImageBundle(broken), /опись|image-bundle|запись/, label);
    }
});

test('bundle: сборка 8 tar по точному image ID + опись с SHA/размером/commit/release', async (t) => {
    const destination = await tempDir(t, 'bundle');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    const dockerMock = makeDocker({ registry });
    const result = await bundleImages(manifest, destination, { run: dockerMock.run });
    assert.equal(result.ok, true);
    assert.equal(result.noOp, false);
    assert.equal(result.images, 8);
    assert.equal(result.rebuilt, 8);
    const saves = dockerMock.calls.filter((args) => args[0] === 'save');
    assert.equal(saves.length, 8);
    for (const [name, imageId] of allEntries(manifest)) {
        assert.ok(
            saves.some((args) => args[1] === imageId),
            'save ' + name,
        );
        const bytes = await readFile(path.join(destination, 'images', name + '.tar'));
        assert.ok(bytes.equals(registry.get(imageId)), 'tar bytes ' + name);
    }
    const bundle = await readImageBundle(destination);
    assert.equal(bundle.format, imageBundleFormat);
    assert.equal(bundle.commit, COMMIT);
    assert.equal(bundle.release, 'fixture-1');
    assert.equal(bundle.bundleId, 'images-' + COMMIT.slice(0, 12));
    assert.deepEqual(bundleEntries(bundle), bundleEntries(bundle));
    for (const [name, imageId] of allEntries(manifest)) {
        const entry = name === 'postgres' ? bundle.postgresImage : bundle.images[name];
        assert.equal(entry.imageId, imageId, 'imageId ' + name);
        assert.equal(entry.file, 'images/' + name + '.tar', 'file ' + name);
        assert.equal(entry.sha256, await digestFile(path.join(destination, 'images', name + '.tar')), 'sha ' + name);
        assert.equal(entry.size, (await stat(path.join(destination, 'images', name + '.tar'))).size, 'size ' + name);
    }
});

test('bundle idempotency: повтор для того же релиза — no-op, tar не пересобираются', async (t) => {
    const destination = await tempDir(t, 'idempotent');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    const first = await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    assert.equal(first.noOp, false);
    const before = {};
    for (const [name] of allEntries(manifest))
        before[name] = await readFile(path.join(destination, 'images', name + '.tar'));
    // Другой registry: если бы случилась пересборка, байты tar изменились бы.
    const mutated = new Map([...registry].map(([id, tar]) => [id, Buffer.concat([tar, Buffer.from('X')])]));
    const second = await bundleImages(manifest, destination, { run: makeDocker({ registry: mutated }).run });
    assert.equal(second.noOp, true);
    assert.equal(second.rebuilt, 0);
    for (const [name] of allEntries(manifest)) {
        const after = await readFile(path.join(destination, 'images', name + '.tar'));
        assert.ok(after.equals(before[name]), 'tar unchanged ' + name);
    }
});

test('bundle: повреждённый tar при повторе останавливает сборку (SHA mismatch)', async (t) => {
    const destination = await tempDir(t, 'corrupt');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const victim = path.join(destination, 'images', 'frontend.tar');
    const buf = await readFile(victim);
    buf[0] ^= 0xff;
    await writeFile(victim, buf);
    await assert.rejects(
        bundleImages(manifest, destination, { run: makeDocker({ registry }).run }),
        /SHA256 tar frontend/,
    );
});

test('bundle: повтор после прерванной сборки — прерванные tar удаляются, сборка завершается', async (t) => {
    const destination = await tempDir(t, 'interrupted');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    // Первая попытка: docker падает после пары save'ов (остались tar'ы, описи нет).
    const interrupted = makeDocker({ registry });
    let saves = 0;
    const failingRun = async (args, options) => {
        if (args[0] === 'save' && ++saves > 2) throw new Error('fixture docker: прервано (load)');
        return interrupted.run(args, options);
    };
    await assert.rejects(bundleImages(manifest, destination, { run: failingRun }), /прервано/);
    const leftover = await readdir(path.join(destination, 'images'));
    assert.equal(leftover.length, 2, 'остались прерванные tar');
    assert.ok(!leftover.includes('postgres.tar'), 'прерванная сборка не дошла до postgres');
    // Повтор: прерванные tar'ы удалены (иначе wx-запись упала бы на EEXIST), сборка доходит до конца.
    const result = await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    assert.equal(result.ok, true);
    assert.equal(result.noOp, false);
    assert.equal(result.rebuilt, 8);
    for (const [name, imageId] of allEntries(manifest)) {
        const bytes = await readFile(path.join(destination, 'images', name + '.tar'));
        assert.ok(bytes.equals(registry.get(imageId)), 'tar bytes ' + name);
    }
    const bundle = await readImageBundle(destination);
    assert.equal(bundle.commit, COMMIT);
    assert.equal(bundle.release, 'fixture-1');
});

test('bundle: существующий бандл с другими image ID отклоняется', async (t) => {
    const destination = await tempDir(t, 'different-id');
    const base = makeManifest();
    const drifted = makeManifest({ images: driftImages() });
    assert.equal(drifted.commit, COMMIT);
    assert.equal(drifted.release, 'fixture-1');
    const registry = new Map([...makeRegistry(base), ...makeRegistry(drifted)]);
    await bundleImages(base, destination, { run: makeDocker({ registry }).run });
    await assert.rejects(
        bundleImages(drifted, destination, { run: makeDocker({ registry }).run }),
        /для других image ID/,
    );
});

test('verify: ID после docker load == опись == release-манифест', async (t) => {
    const destination = await tempDir(t, 'verify');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const result = await verifyImageBundle(destination, manifest, { run: makeDocker({ registry }).run });
    assert.equal(result.ok, true);
    assert.equal(result.format, imageBundleFormat);
    assert.equal(result.commit, COMMIT);
    assert.equal(result.release, 'fixture-1');
    for (const [name, imageId] of allEntries(manifest)) assert.equal(result.images[name], imageId, 'loaded ' + name);
});

test('verify: расхождение ID с release-манифестом фатально, с сервисом и ID', async (t) => {
    const destination = await tempDir(t, 'verify-mismatch');
    const manifest = makeManifest();
    const claimed = makeManifest({ images: driftImages() });
    const registry = new Map([...makeRegistry(manifest), ...makeRegistry(claimed)]);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    await assert.rejects(verifyImageBundle(destination, claimed, { run: makeDocker({ registry }).run }), (error) => {
        assert.match(error.message, /не совпадает с release-манифестом/);
        assert.match(error.message, /frontend/);
        assert.ok(error.message.includes(manifest.images.frontend), 'loaded ID в сообщении');
        assert.ok(error.message.includes(claimed.images.frontend), 'claimed ID в сообщении');
        return true;
    });
});

test('verify: бандл для другого commit — понятный отказ (stale)', async (t) => {
    const destination = await tempDir(t, 'stale');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const otherCommit = makeManifest({ commit: OTHER_COMMIT });
    await assert.rejects(
        verifyImageBundle(destination, otherCommit, { run: makeDocker({ registry }).run }),
        /для другого релиза.*пересоберите/,
    );
});

test('verify: отсутствующий tar — отказ', async (t) => {
    const destination = await tempDir(t, 'missing-tar');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    await rm(path.join(destination, 'images', 'frontend.tar'));
    await assert.rejects(
        verifyImageBundle(destination, manifest, { run: makeDocker({ registry }).run }),
        /Отсутствует tar frontend/,
    );
});

test('load: все образы бандла загружаются, ID сверяются с описью, приложения помечены меткой релиза', async (t) => {
    const destination = await tempDir(t, 'load');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const loadDocker = makeDocker({ registry });
    const result = await loadImageBundle(destination, { run: loadDocker.run });
    assert.equal(result.ok, true);
    assert.equal(result.bundleId, 'images-' + COMMIT.slice(0, 12));
    assert.equal(result.release, 'fixture-1');
    for (const [name, imageId] of allEntries(manifest)) assert.equal(result.images[name], imageId, name);
    // docker save по ID не несёт тегов: load сам метит 7 приложений по релизу, postgres — нет.
    assert.deepEqual(
        result.tagged,
        Object.fromEntries(applicationServices.map((service) => [service, 'neurocenter/' + service + ':fixture-1'])),
    );
    assert.ok(!('postgres' in result.tagged), 'postgres не входит в tagged');
    const tagCalls = loadDocker.calls.filter((args) => args[0] === 'tag');
    assert.equal(tagCalls.length, applicationServices.length);
    for (const [name, imageId] of allEntries(manifest)) {
        if (name === 'postgres') assert.ok(!tagCalls.some((args) => args[1] === imageId), 'postgres не метится');
        else
            assert.ok(
                tagCalls.some((args) => args[1] === imageId && args[2] === 'neurocenter/' + name + ':fixture-1'),
                'tag ' + name,
            );
    }
});

test('load: образ без ID в выводе load определяется через image inspect', async (t) => {
    const destination = await tempDir(t, 'load-byref');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const shortFor = (id) => id.slice(7, 15);
    const byRef = new Map([...registry].map(([id]) => [shortFor(id), id]));
    const loadDocker = makeDocker({
        registry,
        loadOutput: (bytes) => 'Loaded image: neurocenter/fixture:' + shortFor(idForBytes(registry, bytes)) + '\n',
        inspect: (ref) => byRef.get(ref.split(':').pop()),
    });
    const result = await loadImageBundle(destination, { run: loadDocker.run });
    assert.equal(result.ok, true);
    for (const [name, imageId] of allEntries(manifest)) assert.equal(result.images[name], imageId, name);
    // byRef-разрешение ID не мешает разметке приложений
    assert.deepEqual(Object.keys(result.tagged).sort(), [...applicationServices].sort());
});

test('upload+download: roundtrip — байты tar и SHA описи совпадают', async (t) => {
    const source = await tempDir(t, 'upsrc');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, source, { run: makeDocker({ registry }).run });
    const store = makeStore();
    const backupId = 'dr-bundle-1';
    const up = await uploadImageBundle({ source, backupId, store });
    assert.equal(up.ok, true);
    assert.equal(up.images, 8);
    assert.equal(up.verification, 'sha256-readback');
    assert.ok(store.privacyChecks > 0, 'приватность S3 подтверждена');
    const parent = await tempDir(t, 'updst');
    const destination = path.join(parent, 'restored');
    const down = await downloadImageBundle({ destination, backupId, store });
    assert.equal(down.ok, true);
    assert.equal(down.images, 8);
    assert.equal(down.manifestSha256, up.manifestSha256);
    for (const [name] of allEntries(manifest)) {
        const a = await readFile(path.join(source, 'images', name + '.tar'));
        const b = await readFile(path.join(destination, 'images', name + '.tar'));
        assert.ok(a.equals(b), 'tar bytes ' + name);
    }
    assert.deepEqual(await readImageBundle(destination), await readImageBundle(source));
});

test('download: подменённый блок store — SHA mismatch', async (t) => {
    const source = await tempDir(t, 'tamper-src');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, source, { run: makeDocker({ registry }).run });
    const store = makeStore();
    const backupId = 'dr-bundle-tamper';
    await uploadImageBundle({ source, backupId, store });
    const dataKey = [...store.objects.keys()].find((key) => key.includes('/data/') && key.endsWith('/00000000'));
    assert.ok(dataKey, 'data chunk существует');
    store.objects.get(dataKey)[0] ^= 0xff;
    const parent = await tempDir(t, 'tamper-dst');
    const destination = path.join(parent, 'restored');
    await assert.rejects(downloadImageBundle({ destination, backupId, store }), /SHA256 скачанного tar/);
});

test('опись не несёт секретов: точная форма ключей без посторонних полей', async (t) => {
    const destination = await tempDir(t, 'nosecrets');
    const manifest = makeManifest();
    const registry = makeRegistry(manifest);
    await bundleImages(manifest, destination, { run: makeDocker({ registry }).run });
    const raw = JSON.parse(await readFile(path.join(destination, 'image-bundle.json'), 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), [
        'bundleId',
        'commit',
        'createdAt',
        'format',
        'images',
        'postgresImage',
        'release',
    ]);
    for (const name of [...applicationServices, 'postgres']) {
        const entry = name === 'postgres' ? raw.postgresImage : raw.images[name];
        assert.deepEqual(Object.keys(entry).sort(), ['file', 'imageId', 'sha256', 'size']);
    }
    const flat = JSON.stringify(raw).toLowerCase();
    for (const forbidden of ['password', 'token', 'secret', 'credential', 'apikey', 'accesskey']) {
        assert.ok(!flat.includes(forbidden), 'нет ' + forbidden);
    }
});
