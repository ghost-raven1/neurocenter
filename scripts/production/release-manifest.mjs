import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { applicationServices } from './compose-client.mjs';
import { schemaServices, validateSchemaManifest } from './schema-migrations.mjs';

export const releaseManifestFormat = 'neurocenter-release-v1';
export const imagePattern = /^sha256:[a-f0-9]{64}$/;
export const releasePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** git-tracked шаблоны установщиков в корне bridge-dist; бинарные цели — существующие job'ы. */
export const installerTemplates = Object.freeze([
    'install.sh',
    'install.ps1',
    'install_opencode.sh',
    'install_opencode.ps1',
    'install_workspace.sh',
    'install_workspace.ps1',
    'connect.sh',
    'connect.ps1',
]);
const commitPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const supplyNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/;
// Тот же набор исключений, что режет .dockerignore; context: . (compose.production.yml).
// «**/имя» — на любой глубине; «имя/» без «**/» — только в корне.
const excludedAnyDepth = new Set(['node_modules', 'dist', 'build', '.git', 'secrets']);
const excludedRootOnly = new Set(['data', 'offline-assets', '.run', 'playwright-mcp']);
const excludedFiles = new Set(['.npmrc', '.yarnrc', '.yarnrc.yml']);
const excludedPrefixes = ['services/shared/tests', 'deploy/production/local'];
const buildCaContexts = ['docker/build-ca', 'frontend/docker/build-ca'];

function supplyEntries(value, label) {
    const invalid = () => {
        throw new Error('Некорректная supply-опись ' + label);
    };
    if (!Array.isArray(value)) invalid();
    const names = new Set();
    for (const entry of value) {
        if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            Object.keys(entry).length !== 2 ||
            !Object.hasOwn(entry, 'name') ||
            !Object.hasOwn(entry, 'sha256') ||
            typeof entry.name !== 'string' ||
            !supplyNamePattern.test(entry.name) ||
            typeof entry.sha256 !== 'string' ||
            !sha256Pattern.test(entry.sha256)
        )
            invalid();
        if (names.has(entry.name)) invalid();
        names.add(entry.name);
    }
    return value;
}

function vendorContractValue(value) {
    const invalid = () => {
        throw new Error('Некорректный vendor-контракт release-манифеста');
    };
    const sums = value?.sha256sums;
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.package !== 'string' ||
        !value.package ||
        value.package.length > 128 ||
        /[\x00-\x1f\x7f]/.test(value.package) ||
        typeof value.version !== 'string' ||
        !/^\d+\.\d+\.\d+[a-zA-Z0-9._+-]*$/.test(value.version) ||
        typeof value.commit !== 'string' ||
        !commitPattern.test(value.commit) ||
        !sums ||
        typeof sums !== 'object' ||
        Array.isArray(sums) ||
        Object.keys(sums).length === 0 ||
        Object.keys(sums).length > 1024 ||
        Object.entries(sums).some(([file, digest]) => !supplyNamePattern.test(file) || !sha256Pattern.test(digest))
    )
        invalid();
    return value;
}

/** Схема neurocenter-release-v1: commit, метка, 7 image ID, postgres, supply-опись, описи миграций. */
export function validateReleaseManifest(manifest) {
    const invalid = () => {
        throw new Error('Некорректный release-манифест');
    };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) invalid();
    if (manifest.format !== releaseManifestFormat) invalid();
    if (typeof manifest.commit !== 'string' || !commitPattern.test(manifest.commit)) invalid();
    if (typeof manifest.release !== 'string' || !releasePattern.test(manifest.release) || manifest.release === 'latest')
        invalid();
    const images = manifest.images;
    if (
        !images ||
        typeof images !== 'object' ||
        Array.isArray(images) ||
        Object.keys(images).length !== applicationServices.length ||
        applicationServices.some((service) => !imagePattern.test(images[service] || ''))
    )
        invalid();
    if (!imagePattern.test(manifest.postgresImage || '')) invalid();
    if (!imagePattern.test(manifest.nodeExporterImage || '')) invalid();
    const supply = manifest.supply;
    if (!supply || typeof supply !== 'object' || Array.isArray(supply)) invalid();
    for (const key of ['runtime', 'opencode', 'installers']) supplyEntries(supply[key], key);
    vendorContractValue(supply.vendorContract);
    const migrations = manifest.migrations;
    if (
        !migrations ||
        typeof migrations !== 'object' ||
        Array.isArray(migrations) ||
        Object.keys(migrations).length !== schemaServices.length
    )
        invalid();
    for (const service of schemaServices) validateSchemaManifest(service, migrations[service]);
    return manifest;
}

export function buildReleaseManifest({
    commit,
    release,
    images,
    postgresImage,
    nodeExporterImage,
    supply,
    migrations,
}) {
    return validateReleaseManifest({
        format: releaseManifestFormat,
        commit,
        release,
        images,
        postgresImage,
        nodeExporterImage,
        supply,
        migrations,
    });
}

/** Атомарная запись 0600 в закрытый каталог (idiom update.mjs: tmp + rename + fsync каталога). */
export async function writeReleaseManifest(filename, manifest) {
    const value = JSON.stringify(validateReleaseManifest(manifest), null, 2) + '\n';
    const directory = path.dirname(filename);
    for (const level of [path.dirname(directory), directory]) {
        let info;
        try {
            info = await lstat(level);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            await mkdir(level, { recursive: true, mode: 0o700 });
            info = await lstat(level);
        }
        if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
            throw new Error('Каталог release-манифеста должен быть закрытым обычным каталогом');
    }
    const temporary = filename + '.' + randomUUID() + '.tmp';
    try {
        await writeFile(temporary, value, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

/** Пересчёт фактического состояния против манифеста; пустой список = верификация пройдена. */
export function verifyReleaseManifest(manifest, actuals) {
    const expected = validateReleaseManifest(manifest);
    const mismatches = [];
    for (const service of applicationServices) {
        if (expected.images[service] !== actuals?.images?.[service])
            mismatches.push(
                'images.' + service + ': ' + expected.images[service] + ' -> ' + (actuals?.images?.[service] ?? 'нет'),
            );
    }
    if (expected.postgresImage !== actuals?.postgresImage)
        mismatches.push('postgresImage: ' + expected.postgresImage + ' -> ' + (actuals?.postgresImage ?? 'нет'));
    if (expected.nodeExporterImage !== actuals?.nodeExporterImage)
        mismatches.push(
            'nodeExporterImage: ' + expected.nodeExporterImage + ' -> ' + (actuals?.nodeExporterImage ?? 'нет'),
        );
    for (const key of ['runtime', 'opencode', 'installers', 'vendorContract']) {
        if (!isDeepStrictEqual(expected.supply[key], actuals?.supply?.[key]))
            mismatches.push('supply.' + key + ': опись не совпадает с фактическими артефактами');
    }
    for (const service of schemaServices) {
        if (!isDeepStrictEqual(expected.migrations[service], actuals?.migrations?.[service]))
            mismatches.push('migrations.' + service + ': опись не совпадает с закреплённым образом');
    }
    return mismatches;
}

async function sha256File(filename) {
    const hash = createHash('sha256');
    try {
        for await (const chunk of createReadStream(filename)) hash.update(chunk);
    } catch (error) {
        throw new Error('Не удалось прочитать ' + filename, { cause: error });
    }
    return hash.digest('hex');
}

/** Архивы .tgz реально присутствующие в каталоге (пусто = легально); .sha256-сайдкар сверяется с пересчётом. */
async function archiveInventory(bridge, subdirectory) {
    const directory = path.join(bridge, subdirectory);
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
    const inventory = [];
    for (const name of entries
        .filter((entry) => entry.name.endsWith('.tgz') && entry.isFile())
        .map((entry) => entry.name)
        .sort()) {
        const sha256 = await sha256File(path.join(directory, name));
        let sidecar;
        try {
            sidecar = (await readFile(path.join(directory, name + '.sha256'), 'utf8')).trim().split(/\s+/)[0];
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (sidecar !== undefined) {
            if (!sha256Pattern.test(sidecar))
                throw new Error('Некорректный .sha256-сайдкар ' + subdirectory + '/' + name);
            if (sidecar !== sha256)
                throw new Error(
                    'Supply-артефакт ' + subdirectory + '/' + name + ': .sha256-сайдкар не совпадает с пересчётом',
                );
        }
        inventory.push({ name: subdirectory + '/' + name, sha256 });
    }
    return inventory;
}

/** vendor/asset-contract: опись из SOURCE.json, SHA256SUMS пересчитывается по файлам. */
async function vendorContract(root) {
    const directory = path.join(root, 'vendor', 'asset-contract');
    let source;
    try {
        source = JSON.parse(await readFile(path.join(directory, 'SOURCE.json'), 'utf8'));
    } catch {
        throw new Error('Некорректный vendor-контракт SOURCE.json');
    }
    if (
        source?.schemaVersion !== 1 ||
        typeof source.package !== 'string' ||
        !source.package ||
        /[\x00-\x1f\x7f]/.test(source.package) ||
        typeof source.version !== 'string' ||
        !/^\d+\.\d+\.\d+[a-zA-Z0-9._+-]*$/.test(source.version) ||
        typeof source.commit !== 'string' ||
        !commitPattern.test(source.commit) ||
        !Array.isArray(source.files) ||
        source.files.length === 0
    )
        throw new Error('Некорректный vendor-контракт SOURCE.json');
    const sums = new Map();
    for (const line of (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        const match = line.match(/^([a-f0-9]{64})\s{2,}(\S+)$/);
        if (!match || sums.has(match[2])) throw new Error('Некорректная строка SHA256SUMS: ' + line);
        sums.set(match[2], match[1]);
    }
    if (sums.size === 0) throw new Error('Пустой SHA256SUMS');
    for (const [file, expected] of sums) {
        const actual = await sha256File(path.join(directory, file));
        if (actual !== expected) throw new Error('SHA256SUMS не соответствует файлу ' + file);
    }
    for (const entry of source.files) {
        if (
            !entry ||
            typeof entry.path !== 'string' ||
            typeof entry.sha256 !== 'string' ||
            sums.get(entry.path) !== entry.sha256
        )
            throw new Error('SOURCE.json и SHA256SUMS расходятся: ' + (entry?.path ?? 'неизвестный файл'));
    }
    return {
        package: source.package,
        version: source.version,
        commit: source.commit,
        sha256sums: Object.fromEntries(sums),
    };
}

/** Опись supply: архивы runtime/opencode, 8 installer-шаблонов, vendor-контракт с пересчитанными SHA256. */
export async function supplyInventory(root) {
    const bridge = path.join(root, 'bridge-dist');
    const runtime = await archiveInventory(bridge, 'runtime');
    const opencode = await archiveInventory(bridge, 'opencode');
    const installers = [];
    for (const name of installerTemplates) {
        const filename = path.join(bridge, name);
        const info = await lstat(filename).catch(() => null);
        if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error('Нет supply-шаблона установщика ' + name);
        installers.push({ name, sha256: await sha256File(filename) });
    }
    const vendor = await vendorContract(root);
    return { runtime, opencode, installers, vendorContract: vendor };
}

function contextExcluded(relative, name, isDirectory) {
    if (excludedAnyDepth.has(name)) return true;
    if (relative === name && excludedRootOnly.has(name)) return true;
    if (excludedPrefixes.some((prefix) => relative === prefix || relative.startsWith(prefix + '/'))) return true;
    if (!isDirectory && (name.endsWith('.log') || name.startsWith('.env') || excludedFiles.has(name))) return true;
    const slash = relative.length - name.length;
    if (slash > 0 && buildCaContexts.includes(relative.slice(0, slash - 1))) {
        return name !== '.gitkeep' && !/^ca-.+\.pem$/.test(name);
    }
    return false;
}

/** mtime всех файлов build-контекста = SOURCE_DATE_EPOCH (commit timestamp); исключения .dockerignore не трогаются. */
export async function normalizeBuildContext(root, epoch) {
    if (!Number.isSafeInteger(epoch) || epoch <= 0)
        throw new Error('SOURCE_DATE_EPOCH должен быть положительным timestamp commit в секундах');
    const walk = async (directory, relative) => {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            const relativePath = relative === '' ? entry.name : relative + '/' + entry.name;
            if (contextExcluded(relativePath, entry.name, entry.isDirectory())) continue;
            const absolute = path.join(directory, entry.name);
            const info = await lstat(absolute);
            if (!info.isFile() && !info.isDirectory()) continue;
            await utimes(absolute, epoch, epoch);
            if (info.isDirectory()) await walk(absolute, relativePath);
        }
    };
    await utimes(root, epoch, epoch);
    await walk(root, '');
}

/** git-раннер по checkout; используется для HEAD и статуса, не для сборки. */
export function gitCommand(root, args) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: root });
        let output = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            output += chunk;
        });
        // Тот же tail-лимит stderr, что в compose-client.mjs: диагностика без разрастания.
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-16384);
        });
        child.on('error', () => reject(new Error('Не удалось запустить git для сборки')));
        child.on('close', (code) => {
            if (code === 0) resolve(output);
            else reject(new Error('Не выполнена git-команда: ' + args.join(' ') + '\n' + stderr.trim()));
        });
    });
}

/** Сборка только с чистого git-checkout; возвращает commit SHA для манифеста. */
export async function assertCleanCheckout(root, gitRunner) {
    let commit;
    try {
        commit = (await gitRunner(['rev-parse', 'HEAD'])).trim();
    } catch (error) {
        throw new Error('Сборка недоступна вне git-checkout (' + root + '): не удалось определить HEAD', {
            cause: error,
        });
    }
    if (!commitPattern.test(commit))
        throw new Error('Сборка недоступна вне git-checkout (' + root + '): некорректный HEAD');
    let status;
    try {
        status = await gitRunner(['status', '--porcelain']);
    } catch (error) {
        throw new Error('Сборка недоступна вне git-checkout (' + root + '): не удалось проверить рабочее дерево', {
            cause: error,
        });
    }
    const lines = status
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length > 0)
        throw new Error('Сборка только с чистого git-checkout; незакоммиченные изменения:\n' + lines.join('\n'));
    return commit;
}

/** Метка релиза из production .env; та же грамматика, что в update.mjs. */
export function releaseOfEnv(text) {
    const matches = [...text.matchAll(/^NEUROCENTER_RELEASE=(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\r\n#]+))\r?$/gm)];
    if (matches.length !== 1) {
        throw new Error('В .env нужна ровно одна NEUROCENTER_RELEASE');
    }
    return (matches[0][1] ?? matches[0][2] ?? matches[0][3]).trim();
}

async function captureReleaseActuals({
    root,
    client,
    docker,
    composeConfiguration,
    serviceImageIds,
    inspectSchemaManifests,
}) {
    const config = await composeConfiguration(client);
    const postgresName = config.services?.postgres?.image;
    if (typeof postgresName !== 'string' || !postgresName) throw new Error('В production-профиле отсутствует postgres');
    const nodeExporterName = config.services?.node_exporter?.image;
    if (typeof nodeExporterName !== 'string' || !nodeExporterName)
        throw new Error('В production-профиле отсутствует node_exporter');
    const [images, postgresRaw, nodeExporterRaw] = await Promise.all([
        serviceImageIds(config),
        docker(['image', 'inspect', postgresName]),
        docker(['image', 'inspect', nodeExporterName]),
    ]);
    for (const service of applicationServices) {
        if (typeof images?.[service] !== 'string' || !imagePattern.test(images[service]))
            throw new Error('Не закреплён образ ' + service);
    }
    let postgresImage;
    try {
        postgresImage = JSON.parse(postgresRaw)[0]?.Id;
    } catch {
        postgresImage = undefined;
    }
    if (typeof postgresImage !== 'string' || !imagePattern.test(postgresImage))
        throw new Error('Не закреплён образ postgres');
    let nodeExporterImage;
    try {
        nodeExporterImage = JSON.parse(nodeExporterRaw)[0]?.Id;
    } catch {
        nodeExporterImage = undefined;
    }
    if (typeof nodeExporterImage !== 'string' || !imagePattern.test(nodeExporterImage))
        throw new Error('Не закреплён образ node_exporter');
    return {
        images,
        postgresImage,
        nodeExporterImage,
        migrations: await inspectSchemaManifests(images, docker),
        supply: await supplyInventory(root),
    };
}

/** Полный цикл: чистый checkout -> SOURCE_DATE_EPOCH + нормализация mtime -> docker build -> опись -> манифест -> верификация. */
export async function buildProductionRelease({
    root,
    directory,
    client,
    git,
    docker,
    composeConfiguration,
    serviceImageIds,
    inspectSchemaManifests,
    withBuildCa,
}) {
    const commit = await assertCleanCheckout(root, git);
    const epoch = Number((await git(['log', '-1', '--format=%ct', 'HEAD'])).trim());
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error('Не удалось определить timestamp commit сборки');
    const envFile = path.join(directory, '.env');
    const envInfo = await lstat(envFile).catch(() => null);
    if (!envInfo || !envInfo.isFile() || envInfo.isSymbolicLink())
        throw new Error('Для сборки нужен production .env как обычный файл');
    const release = releaseOfEnv(await readFile(envFile, 'utf8'));
    await withBuildCa(root, process.env, async ({ environment }) => {
        // Нормализация после стейджинга CA: свежий ca-*.pem тоже входит в контекст.
        await normalizeBuildContext(root, epoch);
        await client.run(['build'], { inherit: true, environment });
    });
    const actuals = await captureReleaseActuals({
        root,
        client,
        docker,
        composeConfiguration,
        serviceImageIds,
        inspectSchemaManifests,
    });
    const manifest = buildReleaseManifest({ commit, release, ...actuals });
    const filename = path.join(directory, 'releases', release, 'release-manifest.json');
    await writeReleaseManifest(filename, manifest);
    const rechecked = await captureReleaseActuals({
        root,
        client,
        docker,
        composeConfiguration,
        serviceImageIds,
        inspectSchemaManifests,
    });
    const mismatches = verifyReleaseManifest(manifest, rechecked);
    if (mismatches.length > 0)
        throw new Error('Верификация release-манифеста не пройдена:\n- ' + mismatches.join('\n- '));
    return { manifest, filename };
}
