import archiveSource from '../../services/shared/archive-source.cjs';
import {inspectArchiveSource,prepareArchiveSource} from './archive-source.mjs';
import { createRequire } from 'node:module';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { crc32 } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import { installDependencies } from './recipes/upstream.mjs';
import { prepareOpenCodeRag, RAG_SUPPORTED_TARGETS } from './recipes/opencode-rag.mjs';
import { prepareOpenCodeRagPlugin } from './recipes/opencode-rag-plugin.mjs';
import { prepareOpenCodeSnip } from './recipes/opencode-snip.mjs';
import { npmTools, filePlugins, prepareNpmTool, filePluginPublication } from './generic.mjs';
import repositorySource from '../../services/shared/repository-source.cjs';
import { prepareRepository } from './repository-source.mjs';
import runtimeSource from '../../services/shared/tool-runtime-source.cjs';
import { downloadRuntimeAsset, inspectRuntimeSource, prepareRuntimeSource } from './runtime-source.mjs';
import sourceEntrypoint from '../../services/shared/source-entrypoint.cjs';
import ragSource from '../../services/shared/opencode-rag-source.cjs';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const within = (root, file) => { const relative = path.relative(root, file); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const localDirectory = value => typeof value === 'string' && (value === '.' || runtime.portablePath(value.replace(/^\.\//, '')));

/** Источник меняет подготовку дерева, но не формат архива, одобрение или установку. */
export function validateAdditionalSource(source) {
    if(source.type==='archive')return archiveSource.validateArchiveSource(source);
    if (source.type === 'prepared') {
        if (!exact(source, ['type', 'adapter']) || !['opencode-rag', 'opencode-rag-plugin', 'opencode-snip', ...npmTools.map(tool => tool.key), ...filePlugins.map(tool => tool.key)].includes(source.adapter)) throw new Error('Неизвестный подготовленный адаптер.');
    } else if (source.type === 'repository') {
        return repositorySource.validateRepositorySource(source);
    } else if (source.type === 'runtime') {
        return runtimeSource.validateRuntimeSource(source);
    } else if (source.type === 'project') {
        if (!exact(source, ['type', 'directory', 'entrypoint']) || !localDirectory(source.directory) || !runtime.portablePath(source.entrypoint) || !sourceEntrypoint.isSourceEntrypoint(source.entrypoint)) throw new Error('Проект требует относительную папку и исполняемый JS/TS entrypoint внутри неё, без деклараций типов.');
    } else if (source.type === 'release') {
        if (!exact(source, ['type', 'assets']) || !exact(source.assets, runtime.TARGETS) || !Object.keys(source.assets).length) throw new Error('Укажите закреплённые платформенные assets релиза.');
        for (const asset of Object.values(source.assets)) {
            if (!exact(asset, ['url', 'sha256', 'format', 'entrypoint', 'executables']) || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || !['tar.gz', 'zip'].includes(asset.format) || !runtime.portablePath(asset.entrypoint)
                || asset.executables !== undefined && (!Array.isArray(asset.executables) || asset.executables.some(file => !runtime.portablePath(file)))) throw new Error('Релиз требует URL, SHA-256, tar.gz/zip и переносимые пути.');
            runtimeSource.validateRuntimeSource({ type: 'runtime', adapter: 'native', assets: { 'darwin-arm64': { app: asset } } });
        }
    } else throw new Error('Поддерживаются npm, files, project, release, repository, runtime и prepared.');
}

export function additionalSourceTargets(source) {
    if (source.type === 'prepared' && ['opencode-rag', 'opencode-rag-plugin'].includes(source.adapter)) return RAG_SUPPORTED_TARGETS;
    if (source.type === 'repository' && ragSource.isPreparedRagRepository(source)) return RAG_SUPPORTED_TARGETS;
    if (source.type === 'release') return Object.keys(source.assets);
    if (source.type === 'runtime') return runtimeSource.runtimeSourceTargets(source);
    if (source.type === 'archive') return runtimeSource.runtimeSourceTargets(source.runtimeSource);
    if (source.type === 'repository' && source.runtimeSource) return runtimeSource.runtimeSourceTargets(source.runtimeSource);
}

async function projectFiles(source, recipeDirectory, limits = { filesCount: 100, totalBytes: 5 * 1048576, fileBytes: 1048576 }) {
    const directory = path.resolve(recipeDirectory, source.directory);
    if (!within(recipeDirectory, directory)) throw new Error('Исходники выходят за папку рецепта.');
    let parent = recipeDirectory;
    for (const segment of path.relative(recipeDirectory, directory).split(path.sep).filter(Boolean)) {
        parent = path.join(parent, segment);
        if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('Папка проекта не должна быть ссылкой.');
    }
    const files = []; let bytes = 0;
    async function read(prefix = '') {
        for (const item of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
            if (['node_modules', '.git', 'coverage'].includes(item.name) || item.name.toLowerCase() === '.npmrc'
                || item.name === 'dist' && !source.entrypoint.split('/').includes('dist') || /^\.env(?:\.|$)/.test(item.name)) continue;
            const relative = prefix ? prefix + '/' + item.name : item.name;
            if (!runtime.portablePath(relative)) throw new Error('Недопустимый путь исходника: ' + relative);
            const filename = path.join(directory, relative); const stat = await fs.lstat(filename);
            if (stat.isDirectory()) { await read(relative); continue; }
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('В исходниках запрещены ссылки: ' + relative);
            bytes += stat.size;
            if (stat.size > limits.fileBytes || bytes > limits.totalBytes || files.length >= limits.filesCount) throw new Error('Исходники превышают допустимый размер или число файлов для этого источника.');
            files.push({ path: relative, filename, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs });
        }
    }
    await read();
    if (!files.some(file => file.path === source.entrypoint && file.size)) throw new Error('Entry point проекта отсутствует или пуст.');
    return { directory, files };
}

/** Dry-run читает исходники и проверяет границы; зависимости и компилятор не запускаются. */
export async function inspectAdditionalSource(source, { recipeDirectory, output }) {
    if(source.type==='archive')return inspectArchiveSource(source,recipeDirectory);
    if (source.type === 'runtime') return inspectRuntimeSource(source, { recipeDirectory, output });
    if (source.type !== 'project') return;
    const { directory } = await projectFiles(source, recipeDirectory);
    if (output && (within(directory, output) || within(output, directory))) throw new Error('Папки source и output не должны пересекаться.');
}

/** Одинаковый компилятор сохраняет ESM/CJS main guard и границы файлов обоих источников. */
async function compileRuntimeEntry({ directory, workingDirectory, sourceEntry }) {
    const esbuild = require('esbuild');
    let commonJs = /\.(?:cjs|cts)$/.test(sourceEntry);
    let entrypoint = commonJs ? 'entrypoint.cjs' : 'entrypoint.mjs';
    const compile = () => esbuild.build({ absWorkingDir: workingDirectory, entryPoints: [sourceEntry], outfile: path.join(directory, entrypoint),
        bundle: true, packages: 'external', platform: 'node', target: 'node24', format: commonJs ? 'cjs' : 'esm', metafile: true, legalComments: 'eof', logLevel: 'silent',
        ...(!commonJs ? { banner: { js: "import { createRequire as __neurocenterCreateRequire } from 'node:module'; const require = __neurocenterCreateRequire(import.meta.url);" } } : {}) });
    let result = await compile();
    if (!commonJs && Object.entries(result.metafile.inputs).some(([file, input]) => input.format === 'cjs'
        && path.resolve(workingDirectory, file) === path.resolve(workingDirectory, sourceEntry))) {
        commonJs = true;
        entrypoint = 'entrypoint.cjs';
        result = await compile();
        await fs.rm(path.join(directory, 'entrypoint.mjs'));
    }
    for (const input of Object.keys(result.metafile.inputs)) {
        if (!within(workingDirectory, path.resolve(workingDirectory, input))) { throw new Error('Импорт выходит за пределы исходников готового комплекта.'); }
    }
    return { entrypoint, upstream: { compiler: 'esbuild', version: esbuild.version } };
}

/** npm с TS-точкой входа компилируется на площадке; клиент получает обычный JS. */
export async function compileNpmTypeScript(recipe, { directory }) {
    const sourceEntry = `node_modules/${recipe.source.package}/${recipe.source.entrypoint}`;
    const compiled = await compileRuntimeEntry({ directory, workingDirectory: directory, sourceEntry });
    return { ...compiled, upstream: { ...compiled.upstream, entrypoint: sourceEntry } };
}

async function prepareProject(recipe, { directory, recipeDirectory, target }, { limits } = {}) {
    const source = await projectFiles(recipe.source, recipeDirectory, limits);
    const staging = await fs.mkdtemp(path.join(path.dirname(directory), '.project-source-'));
    try {
        for (const file of source.files) {
            const destination = path.join(staging, file.path);
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.copyFile(file.filename, destination, constants.COPYFILE_EXCL);
            const after = await fs.lstat(file.filename);
            if (!after.isFile() || after.nlink !== 1 || after.ino !== file.ino || after.size !== file.size || after.mtimeMs !== file.mtimeMs) { throw new Error('Исходный файл изменился во время подготовки.'); }
        }
        const metadata = source.files.find(file => file.path === 'package.json');
        if (metadata?.size > 1048576) { throw new Error('package.json превышает 1 МиБ.'); }
        const metadataBytes = metadata ? await fs.readFile(path.join(staging, 'package.json')) : undefined;
        const dependencies = metadataBytes ? JSON.parse(metadataBytes.toString('utf8')).dependencies ?? {} : {};
        if (!exact(dependencies, Object.keys(dependencies)) || Object.entries(dependencies).some(([name, version]) =>
            !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || typeof version !== 'string'
            || !/^[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version))) throw new Error('Зависимости исходников должны задавать npm-пакеты с точной, ^ или ~ semver версией. Git, file и install hooks не используются.');
        const lockFile = source.files.find(file => file.path === 'package-lock.json');
        if (lockFile?.size > 16 * 1048576) { throw new Error('package-lock.json превышает 16 МиБ.'); }
        if (lockFile) for (const entry of Object.values(JSON.parse(await fs.readFile(path.join(staging, lockFile.path), 'utf8')).packages ?? {})) {
            if (!entry.resolved) continue;
            const resolved = new URL(entry.resolved);
            if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org' || resolved.username || resolved.password) throw new Error('Lock-файл должен ссылаться только на официальный npm registry.');
        }
        if (Object.keys(dependencies).length) {
            await installDependencies(staging, dependencies, target);
            // npm helper создаёт служебный package.json; компилятор должен видеть исходный module type/imports.
            if (metadataBytes) { await fs.writeFile(path.join(staging, 'package.json'), metadataBytes); }
            await fs.cp(path.join(staging, 'node_modules'), path.join(directory, 'node_modules'), { recursive: true, errorOnExist: true, force: false });
        }
        const compiled = await compileRuntimeEntry({ directory, workingDirectory: staging, sourceEntry: recipe.source.entrypoint });
        await fs.writeFile(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
        try { await fs.copyFile(path.join(staging, 'package-lock.json'), path.join(directory, 'package-lock.json')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        return { ...compiled, upstream: { ...compiled.upstream, files: source.files.length } };
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export async function extractRelease(archive, asset, directory) {
    if ((await fs.stat(archive)).size > runtime.LIMITS.compressedBytes) throw new Error('Архив релиза превышает 256 МиБ.');
    const names = new Set(), prefixes = new Map(); let count = 0, bytes = 0;
    const check = (name, size, type) => {
        const normalized = name.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
        if (!normalized && type === 'Directory') return;
        if (!runtime.portablePath(normalized) || !['File', 'Directory'].includes(type) || names.has(normalized.normalize('NFC').toLowerCase())) throw new Error('Ссылка, повтор или небезопасный путь в релизе.');
        const parts = normalized.split('/');
        for (let length = 1; length <= parts.length; length++) {
            const prefix = parts.slice(0, length).join('/'), key = prefix.normalize('NFC').toLowerCase();
            if (prefixes.has(key) && prefixes.get(key) !== prefix) throw new Error('Конфликт регистра или Unicode в пути релиза.');
            prefixes.set(key, prefix);
        }
        names.add(normalized.normalize('NFC').toLowerCase());
        if (type === 'File') { count++; bytes += size; }
        if (count > runtime.LIMITS.filesCount || bytes > runtime.LIMITS.unpackedBytes) throw new Error('Релиз превышает лимиты готового комплекта.');
    };
    if (asset.format === 'tar.gz') {
        const tar = require('tar');
        const parser = tar.t({ strict: true, filter: (name, entry) => {
            try { check(name, entry.size, entry.type); return true; }
            catch (error) { parser.abort(error); return false; }
        } });
        await pipeline(createReadStream(archive), parser);
        await tar.x({ file: archive, cwd: directory, strict: true, preservePaths: false, noMtime: true, noChmod: true, noResume: false });
    } else {
        const yauzl = require('yauzl');
        const zip = await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
        try {
            await new Promise((resolve, reject) => {
                zip.on('error', reject); zip.on('end', resolve);
                zip.on('entry', entry => {
                    (async () => {
                        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
                        const type = entry.fileName.endsWith('/') ? 'Directory' : 'File';
                        if (mode && ![0o040000, 0o100000].includes(mode) || entry.generalPurposeBitFlag & 1) throw new Error('Ссылки и зашифрованные ZIP-файлы запрещены.');
                        check(entry.fileName, entry.uncompressedSize, type);
                        const destination = path.join(directory, entry.fileName);
                        if (type === 'Directory') await fs.mkdir(destination, { recursive: true });
                        else {
                            await fs.mkdir(path.dirname(destination), { recursive: true });
                            const input = await new Promise((done, fail) => zip.openReadStream(entry, (error, stream) => error ? fail(error) : done(stream)));
                            let checksum = 0;
                            await pipeline(input, new Transform({ transform(chunk, _encoding, done) { checksum = crc32(chunk, checksum); done(null, chunk); } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
                            if (checksum !== entry.crc32) throw new Error('ZIP-файл повреждён: CRC не совпала.');
                        }
                        zip.readEntry();
                    })().catch(reject);
                });
                zip.readEntry();
            });
        } finally { zip.close(); }
    }
    for (const file of asset.executables ?? []) await fs.chmod(path.join(directory, file), 0o755);
}

export async function prepareAdditionalSource(recipe, context) {
    const source = recipe.source;
    if(source.type==='archive')return prepareArchiveSource(recipe,context,{extractRelease});
    if (source.type === 'project') return prepareProject(recipe, context);
    if (source.type === 'repository') return ragSource.isPreparedRagRepository(source)
        ? prepareOpenCodeRagPlugin(context) : prepareRepository(recipe, context, { extractRelease, prepareProject });
    if (source.type === 'runtime') return prepareRuntimeSource(recipe, context, { extractRelease });
    if (source.type === 'prepared') {
        if (source.adapter === 'opencode-rag') return prepareOpenCodeRag(context);
        if (source.adapter === 'opencode-rag-plugin') return prepareOpenCodeRagPlugin(context);
        if (source.adapter === 'opencode-snip') return prepareOpenCodeSnip(context);
        const npm = npmTools.find(tool => tool.key === source.adapter);
        if (npm) return prepareNpmTool(npm, context.directory);
        const plugin = await filePluginPublication(filePlugins.find(tool => tool.key === source.adapter));
        for (const file of plugin.files) await fs.writeFile(path.join(context.directory, file.path), file.content);
        return { entrypoint: plugin.config.entrypoint };
    }
    if (source.type === 'release') {
        const asset = source.assets[context.target];
        const archive = await downloadRuntimeAsset(asset, path.join(context.cacheDirectory ?? path.join(path.dirname(context.directory), '.source-cache'), 'runtime'));
        await extractRelease(archive.filename, asset, context.directory);
        return { entrypoint: asset.entrypoint, executables: asset.executables ?? [], upstream: { url: asset.url, sha256: asset.sha256 } };
    }
    throw new Error('Неизвестный источник.');
}
