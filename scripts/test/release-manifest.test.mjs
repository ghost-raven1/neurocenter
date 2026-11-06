import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, symlink, utimes, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { applicationServices } from '../production/compose-client.mjs';
import { inspectSchemaManifests, schemaServices } from '../production/schema-migrations.mjs';
import {
    assertCleanCheckout,
    buildProductionRelease,
    buildReleaseManifest,
    gitCommand,
    installerTemplates,
    normalizeBuildContext,
    supplyInventory,
    validateReleaseManifest,
    verifyReleaseManifest,
    writeReleaseManifest,
} from '../production/release-manifest.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const image = (letter) => 'sha256:' + letter.repeat(64);
const serviceLetters = ['a', 'b', 'c', 'd', 'e', 'f', '0'];
const driftLetters = ['1', '2', '3', '4', '5', '6', '7'];
const serviceImages = () =>
    Object.fromEntries(applicationServices.map((service, index) => [service, image(serviceLetters[index])]));
const driftImages = () =>
    Object.fromEntries(applicationServices.map((service, index) => [service, image(driftLetters[index])]));
const migrationRows = (service) =>
    service === 'rag-sync-service'
        ? [{ scope: 'data', version: 'project-generations-1', name: 'Поколения проектов', checksum: 'c'.repeat(64) }]
        : [
              { version: 0, name: 'Полная исходная схема', checksum: 'b'.repeat(64) },
              { version: 1, name: 'История установки', checksum: 'c'.repeat(64) },
          ];
const migrationManifests = () => Object.fromEntries(schemaServices.map((service) => [service, migrationRows(service)]));
const vendorContractFixture = () => ({
    package: '@neurocenter/asset-contract',
    version: '1.2.1',
    commit: 'e'.repeat(40),
    sha256sums: { 'README.md': '9'.repeat(64), 'SOURCE.json': '8'.repeat(64) },
});

async function makeVendorContract(directory) {
    await mkdir(directory, { recursive: true });
    const files = {
        'README.md': 'fixture vendor contract\n',
        'package.json': '{"name":"@neurocenter/asset-contract","version":"1.2.1"}\n',
    };
    const sourceText =
        JSON.stringify(
            {
                schemaVersion: 1,
                repository: 'https://example.invalid/neurocenter-assets',
                commit: 'e'.repeat(40),
                package: '@neurocenter/asset-contract',
                version: '1.2.1',
                license: 'UNLICENSED',
                selection: 'fixture',
                files: Object.entries(files).map(([file, content]) => ({
                    path: file,
                    bytes: Buffer.byteLength(content),
                    sha256: sha256(content),
                    gitBlobSha1: 'a'.repeat(40),
                })),
            },
            null,
            2,
        ) + '\n';
    await writeFile(path.join(directory, 'SOURCE.json'), sourceText);
    const sums = [
        ...Object.entries(files).map(([file, content]) => [file, sha256(content)]),
        ['SOURCE.json', sha256(sourceText)],
    ];
    await writeFile(
        path.join(directory, 'SHA256SUMS'),
        sums.map(([file, digest]) => digest + '  ' + file).join('\n') + '\n',
    );
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(directory, file), content);
}

/** Отдельный checkout в tmp: bridge-dist (шаблоны + опциональные архивы) и vendor-контракт. */
async function makeBuildRoot(t, { archives = false, drift = false } = {}) {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release root ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bridge = path.join(root, 'bridge-dist');
    await mkdir(bridge, { recursive: true });
    for (const name of installerTemplates) await writeFile(path.join(bridge, name), 'fixture installer ' + name + '\n');
    if (archives || drift) {
        await mkdir(path.join(bridge, 'runtime'), { recursive: true });
        await writeFile(path.join(bridge, 'runtime', 'asset-sync-linux-x64-0.9.10.tgz'), 'runtime archive bytes');
        await writeFile(
            path.join(bridge, 'runtime', 'asset-sync-linux-x64-0.9.10.tgz.sha256'),
            (drift ? 'f'.repeat(64) : sha256('runtime archive bytes')) + '\n',
        );
        await mkdir(path.join(bridge, 'opencode'), { recursive: true });
        await writeFile(path.join(bridge, 'opencode', 'opencode-linux-x64-baseline.tgz'), 'opencode archive bytes');
        await writeFile(
            path.join(bridge, 'opencode', 'opencode-linux-x64-baseline.tgz.sha256'),
            sha256('opencode archive bytes') + '\n',
        );
    }
    await makeVendorContract(path.join(root, 'vendor', 'asset-contract'));
    return root;
}

const fakeGit =
    (status = '', commit = 'a'.repeat(40)) =>
    async (args) => {
        if (args[0] === 'rev-parse') return commit + '\n';
        if (args[0] === 'status') return status;
        if (args[0] === 'log') return '1793880208\n';
        throw new Error('fixture git: ' + args.join(' '));
    };

/** Мок-docker и inject-зависимости buildProductionRelease; inspectSchemaManifests — настоящий. */
function flowDeps({ root, directory, git, drift = false }) {
    const calls = [];
    const dockerCalls = [];
    let serviceCalls = 0;
    const imageToService = new Map(
        [...Object.entries(serviceImages()), ...Object.entries(driftImages())].map(([service, id]) => [id, service]),
    );
    const docker = async (args) => {
        dockerCalls.push(args.slice());
        if (args[0] === 'run') {
            const imageId = args.find((value) => imageToService.has(value));
            const service = imageId ? imageToService.get(imageId) : undefined;
            assert.ok(service, 'fixture: неизвестный schema-образ в docker run');
            return JSON.stringify(migrationRows(service));
        }
        if (args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: image('8') }]);
        throw new Error('fixture docker: ' + args.join(' '));
    };
    return {
        root,
        directory,
        client: {
            run: async (command, options) => {
                calls.push(['client-run', command.join(' '), options ?? {}]);
                return '';
            },
        },
        git: git ?? fakeGit(),
        docker,
        composeConfiguration: async () => ({
            services: {
                ...Object.fromEntries(applicationServices.map((service) => [service, { image: 'fixture:' + service }])),
                postgres: { image: 'pgvector/pgvector:pg16@sha256:' + '8'.repeat(64) },
            },
        }),
        serviceImageIds: async () => {
            serviceCalls += 1;
            return drift && serviceCalls > 1 ? driftImages() : serviceImages();
        },
        inspectSchemaManifests,
        withBuildCa: async (_root, source, action) => action({ environment: { ...source }, args: [] }),
        calls,
        dockerCalls,
    };
}

async function makeConfigDirectory(root) {
    const directory = path.join(root, 'deploy', 'production', 'local');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.env'), "NEUROCENTER_RELEASE='fixture-1'\n");
    return directory;
}

test('validateReleaseManifest: полный манифест проходит, повреждения отклоняются', () => {
    const manifest = buildReleaseManifest({
        commit: 'a'.repeat(40),
        release: 'fixture-1',
        images: serviceImages(),
        postgresImage: image('d'),
        supply: {
            runtime: [],
            opencode: [],
            installers: [{ name: 'install.sh', sha256: 'b'.repeat(64) }],
            vendorContract: vendorContractFixture(),
        },
        migrations: migrationManifests(),
    });
    assert.equal(validateReleaseManifest(manifest), manifest);
    const cases = [
        [
            'format',
            (value) => {
                value.format = 'other-v1';
            },
        ],
        [
            'commit',
            (value) => {
                value.commit = 'z'.repeat(40);
            },
        ],
        [
            'release latest',
            (value) => {
                value.release = 'latest';
            },
        ],
        [
            'битый image digest',
            (value) => {
                value.images.frontend = 'sha256:' + 'g'.repeat(64);
            },
        ],
        [
            'недостающий образ',
            (value) => {
                delete value.images['api-gateway'];
            },
        ],
        [
            'лишний образ',
            (value) => {
                value.images['postgres'] = image('d');
            },
        ],
        [
            'postgresImage',
            (value) => {
                value.postgresImage = 'pgvector/pgvector:pg16';
            },
        ],
        [
            'supply digest',
            (value) => {
                value.supply.installers[0].sha256 = 'B'.repeat(64);
            },
        ],
        [
            'supply имя',
            (value) => {
                value.supply.installers[0].name = '../install.sh';
            },
        ],
        [
            'vendor контракт',
            (value) => {
                value.supply.vendorContract.commit = 'e'.repeat(10);
            },
        ],
        [
            'опись миграций',
            (value) => {
                value.migrations['catalog-service'] = [];
            },
        ],
    ];
    for (const [label, mutate] of cases) {
        const broken = structuredClone(manifest);
        mutate(broken);
        assert.throws(() => validateReleaseManifest(broken), /манифест|опись|контракт/, label);
    }
});

test('verifyReleaseManifest: пустой список при совпадении и точный список расхождений', () => {
    const actuals = {
        images: serviceImages(),
        postgresImage: image('d'),
        supply: {
            runtime: [],
            opencode: [],
            installers: [{ name: 'install.sh', sha256: 'b'.repeat(64) }],
            vendorContract: vendorContractFixture(),
        },
        migrations: migrationManifests(),
    };
    const manifest = buildReleaseManifest({ commit: 'a'.repeat(40), release: 'fixture-1', ...actuals });
    assert.deepEqual(verifyReleaseManifest(manifest, actuals), []);
    const drifted = {
        ...actuals,
        images: { ...actuals.images, frontend: image('x') },
        migrations: {
            ...actuals.migrations,
            'catalog-service': [
                { version: 0, name: 'Полная исходная схема', checksum: 'z'.repeat(64) },
                { version: 1, name: 'История установки', checksum: 'c'.repeat(64) },
            ],
        },
    };
    const mismatches = verifyReleaseManifest(manifest, drifted);
    assert.equal(mismatches.length, 2);
    assert.ok(mismatches.some((line) => line.startsWith('images.frontend')));
    assert.ok(mismatches.some((line) => line.startsWith('migrations.catalog-service')));
});

test('CLEAN_BUILD: чистый checkout записывает проверенный манифест со всеми секциями', async (t) => {
    const root = await makeBuildRoot(t);
    const directory = await makeConfigDirectory(root);
    const deps = flowDeps({ root, directory });
    const { manifest, filename } = await buildProductionRelease(deps);
    assert.equal(manifest.format, 'neurocenter-release-v1');
    assert.equal(manifest.commit, 'a'.repeat(40));
    assert.equal(manifest.release, 'fixture-1');
    assert.deepEqual(manifest.images, serviceImages());
    assert.equal(manifest.postgresImage, image('8'));
    // EMPTY_SUPPLY: в чистом checkout архивы bridge-dist могут отсутствовать.
    assert.deepEqual(manifest.supply.runtime, []);
    assert.deepEqual(manifest.supply.opencode, []);
    assert.deepEqual(
        manifest.supply.installers.map(({ name }) => name),
        installerTemplates,
    );
    assert.ok(manifest.supply.installers.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
    assert.equal(manifest.supply.vendorContract.version, '1.2.1');
    assert.equal(manifest.supply.vendorContract.commit, 'e'.repeat(40));
    assert.deepEqual(manifest.migrations, migrationManifests());
    assert.ok(deps.calls.some((call) => call[0] === 'client-run' && call[1] === 'build'));
    assert.equal(filename, path.join(directory, 'releases', 'fixture-1', 'release-manifest.json'));
    const info = await stat(filename);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), manifest);
    // Верификация пересчитала состояние: postgres inspect и 3 schema-образов дважды.
    assert.equal(deps.dockerCalls.filter((args) => args[0] === 'image').length, 2);
    assert.equal(deps.dockerCalls.filter((args) => args[0] === 'run').length, 6);
});

test('supply: архивы bridge-dist входят в опись с пересчитанным SHA256', async (t) => {
    const root = await makeBuildRoot(t, { archives: true });
    const directory = await makeConfigDirectory(root);
    const { manifest } = await buildProductionRelease(flowDeps({ root, directory }));
    assert.deepEqual(manifest.supply.runtime, [
        { name: 'runtime/asset-sync-linux-x64-0.9.10.tgz', sha256: sha256('runtime archive bytes') },
    ]);
    assert.deepEqual(manifest.supply.opencode, [
        { name: 'opencode/opencode-linux-x64-baseline.tgz', sha256: sha256('opencode archive bytes') },
    ]);
});

test('DIRTY_TREE: незакоммиченные изменения останавливают сборку до docker', async (t) => {
    const root = await makeBuildRoot(t);
    const directory = await makeConfigDirectory(root);
    const deps = flowDeps({ root, directory, git: fakeGit(' M scripts/production/setup.mjs\n?? stray.txt\n') });
    await assert.rejects(buildProductionRelease(deps), /чистого git-checkout/);
    assert.deepEqual(deps.calls, []);
    assert.equal(deps.dockerCalls.length, 0);
});

test('NOT_A_REPO: каталог вне git не даёт сборки', async (t) => {
    const root = await makeBuildRoot(t);
    const directory = await makeConfigDirectory(root);
    const git = async (args) => {
        if (args[0] === 'rev-parse') throw new Error('fatal: not a git repository');
        return '';
    };
    const deps = flowDeps({ root, directory, git });
    await assert.rejects(buildProductionRelease(deps), /git-checkout/);
    assert.deepEqual(deps.calls, []);
});

test('build без production .env останавливается до docker', async (t) => {
    const root = await makeBuildRoot(t);
    const directory = path.join(root, 'deploy', 'production', 'local');
    await mkdir(directory, { recursive: true });
    const deps = flowDeps({ root, directory });
    await assert.rejects(buildProductionRelease(deps), /production .env/);
    assert.deepEqual(deps.calls, []);
});

test('IMAGE_MISMATCH: расхождение image ID при перепроверке фатально и перечисляет сервисы', async (t) => {
    const root = await makeBuildRoot(t);
    const directory = await makeConfigDirectory(root);
    const deps = flowDeps({ root, directory, drift: true });
    let error;
    try {
        await buildProductionRelease(deps);
    } catch (cause) {
        error = cause;
    }
    assert.ok(error, 'сборка должна завершиться ошибкой');
    assert.match(error.message, /Верификация release-манифеста/);
    for (const service of applicationServices) {
        assert.match(error.message, new RegExp('images\\.' + service), service);
    }
    const written = JSON.parse(
        await readFile(path.join(directory, 'releases', 'fixture-1', 'release-manifest.json'), 'utf8'),
    );
    assert.deepEqual(written.images, serviceImages());
});

test('SUPPLY_DRIFT: .sha256-сайдкар, не совпадающий с пересчётом, фатален с именем файла', async (t) => {
    const root = await makeBuildRoot(t, { drift: true });
    const directory = await makeConfigDirectory(root);
    const deps = flowDeps({ root, directory });
    await assert.rejects(
        buildProductionRelease(deps),
        /Supply-артефакт runtime\/asset-sync-linux-x64-0\.9\.10\.tgz: \.sha256-сайдкар не совпадает с пересчётом/,
    );
    await assert.rejects(stat(path.join(directory, 'releases', 'fixture-1', 'release-manifest.json')), {
        code: 'ENOENT',
    });
});

test('supplyInventory: отсутствующие архивы легальны; drift сайдкара, потеря шаблона и vendor-расхождение фатальны', async (t) => {
    const root = await makeBuildRoot(t, { archives: true });
    const supply = await supplyInventory(root);
    assert.equal(supply.runtime.length, 1);
    assert.equal(supply.opencode.length, 1);
    assert.equal(supply.installers.length, installerTemplates.length);
    assert.equal(supply.vendorContract.package, '@neurocenter/asset-contract');
    const sidecar = path.join(root, 'bridge-dist', 'runtime', 'asset-sync-linux-x64-0.9.10.tgz.sha256');
    await writeFile(sidecar, 'f'.repeat(64) + '\n');
    await assert.rejects(supplyInventory(root), /asset-sync-linux-x64-0\.9\.10\.tgz/);
    await writeFile(sidecar, sha256('runtime archive bytes') + '\n');
    const template = path.join(root, 'bridge-dist', 'connect.ps1');
    await rm(template);
    await assert.rejects(supplyInventory(root), /connect\.ps1/);
    await writeFile(template, 'fixture installer connect.ps1\n');
    await writeFile(path.join(root, 'vendor', 'asset-contract', 'README.md'), 'tampered\n');
    await assert.rejects(supplyInventory(root), /README\.md/);
});

test('normalizeBuildContext: mtime контекста = epoch, исключения не трогаются', async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release mtime ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'source.mjs'), 'x');
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', 'inner.txt'), 'y');
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, '.git', 'config'), '[core]\n');
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'z');
    await mkdir(path.join(root, 'data'));
    await writeFile(path.join(root, 'data', 'blob.bin'), 'd');
    // «data/» в .dockerignore только в корне: вложенный каталог с тем же именем входит в контекст.
    await mkdir(path.join(root, 'sub', 'data'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'data', 'nested.bin'), 'n');
    await writeFile(path.join(root, '.env'), "NEUROCENTER_RELEASE='x'\n");
    await writeFile(path.join(root, 'app.log'), 'log');
    await mkdir(path.join(root, 'docker', 'build-ca'), { recursive: true });
    await writeFile(path.join(root, 'docker', 'build-ca', '.gitkeep'), '');
    await writeFile(path.join(root, 'docker', 'build-ca', 'ca-fixture.pem'), 'PEM');
    await writeFile(path.join(root, 'docker', 'build-ca', 'extra.pem'), 'LEGACY');
    await mkdir(path.join(root, 'frontend', 'docker', 'build-ca'), { recursive: true });
    await writeFile(path.join(root, 'frontend', 'docker', 'build-ca', 'ca-fixture.pem'), 'PEM2');
    await mkdir(path.join(root, 'services', 'shared', 'tests'), { recursive: true });
    await writeFile(path.join(root, 'services', 'shared', 'tests', 'case.mjs'), 't');
    await mkdir(path.join(root, 'deploy', 'production', 'local'), { recursive: true });
    await writeFile(path.join(root, 'deploy', 'production', 'local', '.env'), 'x');
    await mkdir(path.join(root, 'secrets'));
    await writeFile(path.join(root, 'secrets', 'token'), 's');
    const epoch = 1793880208,
        odd = epoch + 4321;
    const treePaths = async (directory) => {
        const paths = [];
        const walk = async (current, relative) => {
            for (const entry of await readdir(current, { withFileTypes: true })) {
                const relativePath = relative === '' ? entry.name : relative + '/' + entry.name;
                paths.push(relativePath);
                if (entry.isDirectory()) await walk(path.join(current, entry.name), relativePath);
            }
        };
        await walk(directory, '');
        return paths;
    };
    for (const relative of await treePaths(root)) await utimes(path.join(root, relative), odd, odd);
    await utimes(root, odd, odd);
    await normalizeBuildContext(root, epoch);
    const included = new Set([
        'source.mjs',
        'sub',
        'sub/inner.txt',
        'sub/data',
        'sub/data/nested.bin',
        'docker',
        'docker/build-ca',
        'docker/build-ca/.gitkeep',
        'docker/build-ca/ca-fixture.pem',
        'frontend',
        'frontend/docker',
        'frontend/docker/build-ca',
        'frontend/docker/build-ca/ca-fixture.pem',
        'services',
        'services/shared',
        'deploy',
        'deploy/production',
    ]);
    const excluded = new Set([
        '.git',
        '.git/config',
        'node_modules',
        'node_modules/pkg',
        'node_modules/pkg/index.js',
        'data',
        'data/blob.bin',
        '.env',
        'app.log',
        'docker/build-ca/extra.pem',
        'services/shared/tests',
        'services/shared/tests/case.mjs',
        'deploy/production/local',
        'deploy/production/local/.env',
        'secrets',
        'secrets/token',
    ]);
    for (const relative of await treePaths(root)) {
        const expected = included.has(relative) ? epoch : excluded.has(relative) ? odd : null;
        assert.ok(expected !== null, 'неучтённый путь ' + relative);
        assert.equal(Math.floor((await stat(path.join(root, relative))).mtimeMs / 1000), expected, relative);
    }
    assert.equal(Math.floor((await stat(root)).mtimeMs / 1000), epoch);
});

test('writeReleaseManifest: закрытая атомарная запись; повреждённый манифест не трогает файл', async (t) => {
    const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release write ')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const supply = {
        runtime: [],
        opencode: [],
        installers: [{ name: 'install.sh', sha256: 'b'.repeat(64) }],
        vendorContract: vendorContractFixture(),
    };
    const manifest = buildReleaseManifest({
        commit: 'a'.repeat(40),
        release: 'fixture-1',
        images: serviceImages(),
        postgresImage: image('d'),
        supply,
        migrations: migrationManifests(),
    });
    const filename = path.join(directory, 'releases', 'fixture-1', 'release-manifest.json');
    await writeReleaseManifest(filename, manifest);
    assert.equal((await stat(path.dirname(path.dirname(filename)))).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), manifest);
    const next = buildReleaseManifest({
        commit: 'b'.repeat(40),
        release: 'fixture-1',
        images: serviceImages(),
        postgresImage: image('d'),
        supply,
        migrations: migrationManifests(),
    });
    await writeReleaseManifest(filename, next);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).commit, 'b'.repeat(40));
    await assert.rejects(writeReleaseManifest(filename, { ...next, format: 'broken' }), /манифест/);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).commit, 'b'.repeat(40));
    assert.deepEqual(
        (await readdir(path.dirname(filename))).filter((name) => name.endsWith('.tmp')),
        [],
    );
    const linked = path.join(directory, 'linked');
    await symlink(path.join(directory, 'releases', 'fixture-1'), linked);
    await assert.rejects(writeReleaseManifest(path.join(linked, 'release-manifest.json'), next), /каталог/);
});

test('assertCleanCheckout: реальный git-checkout — чистый проходит, dirty и не-репо отклоняются', async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release git ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (args) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + (result.stderr || '').trim());
        return result.stdout;
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    await writeFile(path.join(root, 'file.txt'), 'v1\n');
    git(['add', 'file.txt']);
    git(['commit', '-q', '-m', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    assert.equal(await assertCleanCheckout(root, (args) => gitCommand(root, args)), commit);
    assert.ok(Number((await gitCommand(root, ['log', '-1', '--format=%ct', 'HEAD'])).trim()) > 0);
    await writeFile(path.join(root, 'file.txt'), 'v2\n');
    await assert.rejects(
        assertCleanCheckout(root, (args) => gitCommand(root, args)),
        /чистого git-checkout/,
    );
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release outside ')));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await assert.rejects(
        assertCleanCheckout(outside, (args) => gitCommand(outside, args)),
        /git-checkout/,
    );
});

test('gitCommand: неудачная git-команда несёт tail stderr в тексте ошибки', async (t) => {
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nc release git stderr ')));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await assert.rejects(gitCommand(outside, ['rev-parse', 'HEAD']), (error) => {
        // Локаль-независимо: команда в сообщении и непустой tail stderr после перевода строки.
        assert.match(error.message, /^Не выполнена git-команда: rev-parse HEAD\n\S+/);
        return true;
    });
});
