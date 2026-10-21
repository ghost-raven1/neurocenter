#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {toolRuntimePath} from './supply-layout.mjs';
import { readyManifest } from './manifest.mjs';
import {exportBuiltAsset} from './source-envelope.mjs';
import {capturePreparedSource} from './prepared-source-snapshot.mjs';
import { packRuntime } from './pack.mjs';
import { publishCatalog } from './publish.mjs';
import { installDependencies } from './recipes/upstream.mjs';
import { compileNpmTypeScript, inspectAdditionalSource, prepareAdditionalSource } from './source-adapters.mjs';
import { validateRecipe } from './recipe-schema.mjs';
import runtimeSource from '../../services/shared/tool-runtime-source.cjs';
import sourceEntrypoint from '../../services/shared/source-entrypoint.cjs';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

/** CLI по умолчанию только собирает; публикация включается отдельным явным флагом. */
export function parseBuildArguments(args) {
    const options = { dryRun: false, publish: false };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (seen.has(argument)) { throw new Error('Параметр повторён: ' + argument); }
        seen.add(argument);
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        if (argument === '--publish') { options.publish = true; continue; }
        if (argument === '--progress') { options.progress = true; continue; }
        const field = { '--recipe': 'recipePath', '--output': 'output' }[argument];
        if (!field || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error('Параметры: --recipe <recipe.json> --output <новая пустая папка> [--dry-run] [--publish] [--progress].');
        }
        options[field] = args[++index];
    }
    if (!options.recipePath || !options.output || options.dryRun && options.publish) {
        throw new Error('Укажите --recipe и --output; --dry-run нельзя совмещать с --publish.');
    }
    return options;
}

async function jsonFile(filename, limit = 64 * 1024) {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) { throw new Error('Нужен обычный JSON-файл допустимого размера: ' + filename); }
    return JSON.parse(await fs.readFile(filename, 'utf8'));
}

/** Формат .js определяется ближайшим package.json; неоднозначные модули не переписываются. */
async function commonJsEntrypoint(directory, entrypoint) {
    if (/\.cjs$/i.test(entrypoint)) { return true; }
    if (!/\.js$/i.test(entrypoint)) { return false; }
    let parent = path.dirname(path.join(directory, entrypoint));
    while (true) {
        try { return (await jsonFile(path.join(parent, 'package.json'), 1048576)).type === 'commonjs'; }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
        if (parent === directory) { return false; }
        parent = path.dirname(parent);
    }
}

/** Проверяет новый путь без создания папок; учитывает реальные пути существующих родителей. */
export async function inspectBuildOutput(filename) {
    const absolute = path.resolve(filename);
    let ancestor = absolute;
    while (true) {
        try {
            const info = await fs.lstat(ancestor);
            if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Путь output должен вести в обычную папку, без ссылок.'); }
            const canonical = path.join(await fs.realpath(ancestor), path.relative(ancestor, absolute));
            if (ancestor === absolute && (await fs.readdir(absolute)).length) { throw new Error('Папка output должна быть новой или пустой. Готовые комплекты не перезаписываются.'); }
            return canonical;
        } catch (error) {
            if (error.code !== 'ENOENT') { throw error; }
            const parent = path.dirname(ancestor);
            if (parent === ancestor) { throw error; }
            ancestor = parent;
        }
    }
}

async function sourceDirectory(recipeDirectory, relative) {
    let current = recipeDirectory;
    for (const part of relative.split('/').filter(part => part && part !== '.')) {
        current = path.join(current, part);
        const info = await fs.lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Папка исходных файлов не должна содержать ссылки.'); }
    }
    const canonical = await fs.realpath(current);
    if (!within(recipeDirectory, canonical)) { throw new Error('Исходные файлы должны находиться внутри папки recipe.'); }
    return canonical;
}

async function readFiles(directory, prefix = '', result = []) {
    for (const name of (await fs.readdir(path.join(directory, prefix))).sort()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (!runtime.portablePath(relative)) { throw new Error('Непереносимый путь исходного файла: ' + relative); }
        const filename = path.join(directory, relative);
        const before = await fs.lstat(filename);
        if (before.isDirectory()) { await readFiles(directory, relative, result); continue; }
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) { throw new Error('Ссылки и специальные исходные файлы запрещены: ' + relative); }
        if (/\.(?:ts|tsx)$/.test(relative) && !/\.d\.ts$/.test(relative)) { throw new Error('files принимает готовый JavaScript; для TypeScript используйте источник project со сборкой.'); }
        if (before.size > 1048576 || result.length >= 100) { throw new Error('Для files допустимы 100 файлов и 1 МиБ на файл.'); }
        const bytes = await fs.readFile(filename);
        const content = bytes.toString('utf8');
        const after = await fs.lstat(filename);
        if (content.includes('\0') || !Buffer.from(content).equals(bytes)) { throw new Error('Источник files принимает только текст UTF-8: ' + relative); }
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) { throw new Error('Исходный файл изменился во время чтения.'); }
        result.push({ path: relative, content });
        if (result.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > 5 * 1048576) { throw new Error('Источник files превышает 5 МиБ.'); }
    }
    return result;
}

function publication(recipe, config, files = []) {
    const suppliedRuntime = recipe.source.type === 'runtime' ? recipe.source : recipe.source.runtimeSource;
    return { name: recipe.name, kind: recipe.kind, description: recipe.description, revision: recipe.revision, tags: recipe.tags,
        origin: recipe.source.type === 'npm' ? `https://www.npmjs.com/package/${recipe.source.package}`
            : recipe.source.type === 'repository' ? recipe.source.url : `neurocenter:recipe/${recipe.key}`,
        compatibility: suppliedRuntime
            ? `Автономный ${runtimeSource.runtimeAdapterLabel(suppliedRuntime.adapter)}; ${['python', 'java', 'dotnet'].includes(suppliedRuntime.adapter) ? 'runtime включён в поставку' : 'готовая программа для целевой платформы'}. Проверка запуска выполняется отдельно.`
            : recipe.source.type === 'release' ? 'Готовая поставка релиза для целевой платформы. Проверка запуска выполняется отдельно.'
            : 'Готовый JavaScript; встроенный Node моста. Проверка запуска выполняется отдельно.', config, files };
}

function configuration(recipe, config, artifacts) {
    const supplied = { ...config, ...recipe.config, extra: { ...config?.extra, ...recipe.config?.extra } };
    return { ...(recipe.kind === 'mcp' ? { transport: 'stdio', args: [] } : {}), ...supplied,
        extra: { ...supplied.extra, runtimeArtifacts: artifacts } };
}

async function inspectRecipe(recipe, recipeDirectory, output) {
    let validatePublication;
    try { ({ validatePublication } = require('./dist/publication/publication-validation.js')); }
    catch { throw new Error('Сначала соберите catalog-service: npm run build в services/catalog-service.'); }
    let files;
    if (recipe.source.type === 'files') {
        const directory = await sourceDirectory(recipeDirectory, recipe.source.directory);
        if (within(directory, output) || within(output, directory)) { throw new Error('Папки output и source не должны пересекаться.'); }
        files = await readFiles(directory);
        if (!files.some(file => file.path === recipe.source.entrypoint && file.content.trim())) { throw new Error('Точка входа отсутствует или пуста.'); }
        // Тот же валидатор исключает .env, конфликты путей и секретные параметры до первой записи.
        validatePublication(publication(recipe, { ...(recipe.kind === 'mcp' ? { transport: 'stdio', command: 'node', args: [] } : {}), ...recipe.config, entrypoint: recipe.source.entrypoint }, files));
    } else if (recipe.source.type !== 'npm') { await inspectAdditionalSource(recipe.source, { recipeDirectory, output }); }
    const entrypoint = recipe.source.type === 'npm' && !sourceEntrypoint.isTypeScriptEntrypoint(recipe.source.entrypoint)
        ? `node_modules/${recipe.source.package}/${recipe.source.entrypoint}` : 'entrypoint.mjs';
    const placeholder = { target: recipe.targets[0], sha256: '0'.repeat(64), compressedBytes: 1, unpackedBytes: 1, filesCount: 1, entrypoint };
    validatePublication(publication(recipe, configuration(recipe, undefined, [placeholder])));
    return files;
}

async function prepareSource(recipe, context, files) {
    if (recipe.source.type === 'npm') {
        await installDependencies(context.directory, { [recipe.source.package]: recipe.source.version }, context.target);
        const packageRoot = path.join(context.directory, 'node_modules', recipe.source.package);
        const metadata = await jsonFile(path.join(packageRoot, 'package.json'), 1048576);
        if (metadata.name !== recipe.source.package || metadata.version !== recipe.source.version) { throw new Error('npm установил другую версию пакета.'); }
        if (sourceEntrypoint.isTypeScriptEntrypoint(recipe.source.entrypoint)) { return compileNpmTypeScript(recipe, context); }
        // Сам entrypoint сохраняет process.argv[1] и upstream CLI main guard; обёртка не нужна.
        return { entrypoint: `node_modules/${recipe.source.package}/${recipe.source.entrypoint}` };
    }
    if (recipe.source.type === 'files') {
        for (const file of files) {
            const destination = path.join(context.directory, file.path);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, file.content, { flag: 'wx' });
        }
        return { entrypoint: recipe.source.entrypoint };
    }
    return prepareAdditionalSource(recipe, context);
}

/** Все источники проходят один pack → descriptor → readyManifest; сборка не запускает расширение. */
export async function buildRecipe({ recipe: input, recipePath, output, dryRun = false, publish = false, onProgress }) {
    if (Number(process.versions.node.split('.')[0]) < 24) { throw new Error('Сборка расширений требует Node.js 24.'); }
    if (!recipePath || !output || dryRun && publish) { throw new Error('Нужны recipePath и output; dry-run нельзя публиковать.'); }
    const recipeFile = path.resolve(recipePath);
    const recipeDirectory = await fs.realpath(path.dirname(recipeFile));
    const recipe = validateRecipe(input ?? await jsonFile(recipeFile));
    const destination = await inspectBuildOutput(output);
    const files = await inspectRecipe(recipe, recipeDirectory, destination);
    if (dryRun) { return { ok: true, dryRun: true, key: recipe.key, kind: recipe.kind, targets: recipe.targets, output: destination }; }
    const prepared=recipe.source.type==='prepared'?await capturePreparedSource():undefined,preparedInputs=prepared?.files;
    await fs.mkdir(destination, { recursive: true });
    if ((await fs.readdir(destination)).length) { throw new Error('Папка output перестала быть пустой.'); }
    const lockPath = path.join(destination, '.build-lock.json');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    const artifacts = [], descriptors = [], sources = [], locks = [];
    let sourceConfig;
    let preparedConfig = false;
    let verified = false;
    try {
        for (const target of recipe.targets) {
            await onProgress?.({ type: 'build-progress', target, completed: descriptors.length, total: recipe.targets.length });
            const directory = await fs.mkdtemp(path.join(destination, '.build-'));
            try {
                const prepared = await prepareSource(recipe, { target, directory, recipeDirectory, cacheDirectory: path.join(destination, '.source-cache') }, files);
                let { entrypoint } = prepared;
                const { executables = [], config } = prepared;
                if (preparedConfig && !isDeepStrictEqual(sourceConfig, config)) { throw new Error('Платформенные источники задают разную конфигурацию подключения.'); }
                sourceConfig = config;
                preparedConfig = true;
                if (!runtime.portablePath(entrypoint)) { throw new Error('Подготовленный entrypoint должен быть переносимым путём внутри комплекта.'); }
                const entry = await fs.lstat(path.join(directory, entrypoint));
                if (!entry.isFile() || entry.isSymbolicLink() || !entry.size) { throw new Error('Подготовленный entrypoint отсутствует, пуст или заменён ссылкой.'); }
                let pluginFacade;
                if (recipe.kind === 'plugin' && await commonJsEntrypoint(directory, entrypoint)) {
                    // OpenCode принимает ESM default factory; raw CJS namespace содержит лишние метаданные Bun.
                    const facade = entrypoint + '.mjs';
                    await fs.writeFile(path.join(directory, facade), `export { default } from ${JSON.stringify('./' + encodeURIComponent(path.posix.basename(entrypoint)))};\n`, { flag: 'wx' });
                    pluginFacade = { format: 'esm-default', source: entrypoint, entrypoint: facade };
                    entrypoint = facade;
                }
                const archivePath = `${recipe.key}-${target}.tar.gz`;
                const descriptor = await packRuntime({ directory, archivePath: path.join(destination, archivePath), target, entrypoint, executables });
                const finalArchive=path.join(destination,toolRuntimePath(descriptor.sha256));await fs.mkdir(path.dirname(finalArchive),{recursive:true});
                await fs.rename(path.join(destination,archivePath),finalArchive);
                const descriptorPath = `${recipe.key}-${target}.json`;
                await fs.writeFile(path.join(destination, descriptorPath), JSON.stringify(descriptor, null, 2) + '\n', { flag: 'wx' });
                artifacts.push({ archivePath, descriptorPath }); descriptors.push(descriptor);
                const lock = path.join(directory, 'package-lock.json');
                try {
                    const bytes = await fs.readFile(lock);
                    const filename = `lock-${target}.json`;
                    await fs.writeFile(path.join(destination, filename), bytes, { flag: 'wx' });
                    locks.push({ target, file: filename, sha256: hash(bytes) });
                } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
                for (const relative of prepared.locks ?? []) {
                    if (!runtime.portablePath(relative) || path.posix.basename(relative) !== relative) throw new Error('Некорректное имя lock-файла producer.');
                    const bytes = await fs.readFile(path.join(directory, relative));
                    const filename = `lock-${target}-${relative}`;
                    await fs.writeFile(path.join(destination, filename), bytes, { flag: 'wx' });
                    locks.push({ target, file: filename, sha256: hash(bytes) });
                }
                sources.push({ target, ...(prepared.upstream ? { upstream: prepared.upstream } : {}), entrypoint, ...(pluginFacade ? { pluginFacade } : {}) });
                await onProgress?.({ type: 'build-progress', target, completed: descriptors.length, total: recipe.targets.length });
            } finally { await fs.rm(directory, { recursive: true, force: true }); }
        }
        if(prepared&&(await capturePreparedSource()).revision!==prepared.revision)throw new Error('Исходники producer изменились во время сборки. Архивы сохранены, asset не опубликован; повторите сборку.');
        const manifestPath=await exportBuiltAsset({recipe,recipeDirectory,destination,preparedInputs,
            publication:publication(recipe,configuration(recipe,sourceConfig,descriptors)),descriptors,sources,locks});
        await readyManifest(manifestPath);
        verified = true;
        // Путь от provenance остаётся действительным при переносе готовой поставки.
        const recipeSnapshot = 'recipe.json';
        await fs.writeFile(path.join(destination, recipeSnapshot), JSON.stringify(recipe, null, 2) + '\n', { flag: 'wx' });
        await fs.writeFile(path.join(destination, 'provenance.json'), JSON.stringify({ schemaVersion: 1, recipePath: recipeSnapshot, recipeSha256: hash(JSON.stringify(recipe)),
            nodeVersion: process.versions.node, sources, locks, artifacts: descriptors, runtimeChecked: false }, null, 2) + '\n', { flag: 'wx' });
        const result = { ok: true, dryRun: false, manifest: manifestPath, key: recipe.key, targets: recipe.targets, runtimeChecked: false };
        return publish ? { ...result, publication: await publishCatalog({ asset: manifestPath, baseUrl: 'http://localhost:5173', dryRun: false }) } : result;
    } catch (error) {
        // asset.json существует только для полностью проверяемого комплекта; staging всегда удалён.
        if (!verified) { await fs.rm(path.join(destination, 'asset.json'), { force: true }); }
        throw error;
    } finally {
        await fs.rm(path.join(destination, '.source-cache'), { recursive: true, force: true });
        await fs.rm(lockPath, { force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.umask(0o077);
    let progressOutput=false;
    Promise.resolve().then(async () => {
        const { progress, ...options } = parseBuildArguments(process.argv.slice(2));
        progressOutput=progress;
        const result = await buildRecipe({ ...options, ...(progress ? { onProgress: event => process.stdout.write(JSON.stringify(event) + '\n') } : {}) });
        console.log(JSON.stringify(result, null, progress ? undefined : 2));
    })
        .catch(error => {
            if(progressOutput&&['SOURCE_RESOURCE_UNSUPPORTED','PYTHON_DEPENDENCIES_UNAVAILABLE','PYTHON_RUNTIME_UNAVAILABLE','PYTHON_SOURCE_INVALID'].includes(error?.code))process.stdout.write(JSON.stringify({type:'build-error',code:error.code})+'\n');
            console.error(error instanceof Error ? error.message : 'Сборка не выполнена.'); process.exitCode = 1;
        });
}
