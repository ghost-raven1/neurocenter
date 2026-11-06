import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPackages } from './isolated-build-source.mjs';

/** AD-10: актуальность dist/ против src/ — stamp входа сборки в .run и guard до test-шагов. */

const digest = (value) => createHash('sha256').update(value).digest('hex');
const distPackages = buildPackages.filter(([id]) => id !== 'frontend');
const distEntry = new Map(distPackages.map(([, directory, entry]) => [directory, entry]));
const bridgeDirectory = 'mcp/neurocenter-asset-sync';
const serviceConfigs = ['tsconfig.json', 'tsconfig.build.json', 'nest-cli.json', 'package.json'];
const bridgeConfigs = ['tsconfig.json', 'package.json', 'package-lock.json'];
const bridgeVendor = ['vendor/ollama-runtime/package.json', 'vendor/ollama-runtime/index.js'];
const stampVersion = 1;
const usage = 'Использование: node scripts/workspace/dist-freshness.mjs (--write | --check) <dir>';

const stale = (directory, reason) => {
    const error = new Error(
        `Сборка ${directory} устарела: ${reason}. Выполните run nest build (npm run build в ${directory}) и повторите проверку.`,
    );
    error.code = 'DIST_STALE';
    return error;
};

/** Рекурсивный список регулярных файлов каталога; ссылки внутри входа сборки недопустимы. */
async function treeNames(root, directory) {
    const base = path.join(root, directory);
    const names = [];
    const visit = async (folder, prefix) => {
        let entries;
        try {
            entries = await fs.readdir(folder, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
        for (const item of entries) {
            const relative = prefix ? `${prefix}/${item.name}` : item.name;
            const info = await fs.lstat(path.join(folder, item.name));
            if (info.isSymbolicLink())
                throw new Error(`Ссылка во входах сборки ${directory} не поддерживается: ${relative}`);
            if (info.isDirectory()) await visit(path.join(folder, item.name), relative);
            else if (info.isFile()) names.push(relative);
        }
    };
    await visit(base, '');
    return names;
}

/** Closure входов сборки пакета: src/ и build-конфиги; у моста — vendor, lockfile и shared-файлы. */
export async function stampInputNames(root, directory) {
    if (!distEntry.has(directory)) throw new Error(`Неизвестный dist-пакет freshness-guard: ${directory}`);
    if (directory === bridgeDirectory) {
        const shared = (
            await import(pathToFileURL(path.join(root, directory, 'scripts/runtime-shared-files.mjs')).href)
        ).BRIDGE_SHARED_RUNTIME_FILES;
        if (!Array.isArray(shared) || shared.some((name) => typeof name !== 'string'))
            throw new Error('runtime-shared-files.mjs не экспортирует список shared-файлов.');
        return [
            ...(await treeNames(root, `${directory}/src`)).map((name) => `${directory}/src/${name}`),
            ...bridgeConfigs.map((name) => `${directory}/${name}`),
            ...bridgeVendor.map((name) => `${directory}/${name}`),
            ...[...shared].sort().map((name) => `services/shared/${name}`),
        ].sort();
    }
    return [
        ...(await treeNames(root, `${directory}/src`)).map((name) => `${directory}/src/${name}`),
        ...serviceConfigs.map((name) => `${directory}/${name}`),
    ].sort();
}

/** Один sha256 по отсортированному closure; единый механизм для postbuild-stamp и guard. */
export async function stampDigest(root, directory) {
    const records = {};
    for (const name of await stampInputNames(root, directory)) {
        const info = await fs.lstat(path.join(root, name));
        if (!info.isFile() || info.isSymbolicLink())
            throw new Error(`Вход freshness-guard должен быть обычным файлом: ${name}`);
        records[name] = digest(await fs.readFile(path.join(root, name)));
    }
    return digest(JSON.stringify(records));
}

const stampFile = (root, directory) => path.join(root, '.run', 'dist-stamps', `${directory}.json`);

/** postbuild успешной сборки фиксирует closure входов; mtime и git-HEAD не участвуют. */
export async function writeStamp(root, directory) {
    const srcSha256 = await stampDigest(root, directory);
    const file = stampFile(root, directory);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, JSON.stringify({ schemaVersion: stampVersion, srcSha256 }, null, 2) + '\n', {
        mode: 0o600,
    });
    return srcSha256;
}

/** До test-шага: нет stamp, closure изменился или отсутствует dist/entry — явная ошибка сборки. */
export async function assertDistFresh(root, directory) {
    const entry = distEntry.get(directory);
    if (!entry) throw new Error(`Неизвестный dist-пакет freshness-guard: ${directory}`);
    let stamp;
    try {
        stamp = JSON.parse(await fs.readFile(stampFile(root, directory), 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) throw stale(directory, 'нет stamp успешной сборки');
        throw error;
    }
    if (stamp?.schemaVersion !== stampVersion || !/^[a-f0-9]{64}$/.test(stamp?.srcSha256))
        throw stale(directory, 'stamp сборки некорректна — выполните чистую сборку');
    if ((await stampDigest(root, directory)) !== stamp.srcSha256)
        throw stale(directory, 'src/ или build-конфиги изменились после сборки');
    let target;
    try {
        target = await fs.lstat(path.join(root, directory, 'dist', entry));
    } catch (error) {
        if (error.code === 'ENOENT') throw stale(directory, `отсутствует dist/${entry}`);
        throw error;
    }
    if (!target.isFile()) throw stale(directory, `отсутствует dist/${entry}`);
}

/** CLI делит тот же механизм: --write для postbuild, --check для ручной проверки. */
export async function main(args) {
    if (args.length !== 2 || !['--write', '--check'].includes(args[0])) {
        console.error(usage);
        return 1;
    }
    const [mode, directory] = args,
        root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    try {
        if (mode === '--write') console.log(`stamp ${directory}: ${await writeStamp(root, directory)}`);
        else await assertDistFresh(root, directory);
        return 0;
    } catch (error) {
        console.error(error.message);
        return 1;
    }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    process.exitCode = await main(process.argv.slice(2));
