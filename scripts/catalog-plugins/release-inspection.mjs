import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import { downloadRuntimeCandidate } from './runtime-source.mjs';
import { extractRelease } from './source-adapters.mjs';
import {inspectPythonSource,pythonEntrypointFiles} from './python-inspection.mjs';
import {payloadDescription} from './payload-description.mjs';
const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));

/** Actual executable headers establish OS/CPU; filename hints cannot override their platform. */
export function executableTargets(bytes, depth = 0) {
    if (depth > 1) return [];
    if (bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
        if (bytes[4] !== 2 || bytes[5] !== 1 || ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readBigUInt64LE(24) === 0n) return [];
        const arch = { 62: 'x64', 183: 'arm64' }[bytes.readUInt16LE(18)]; if (!arch) return [];
        const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
        if (size < 56 || count > 4096 || offset + size * count > bytes.length) return [];
        for (let index = 0; index < count; index++) {
            const at = offset + size * index;
            if (bytes.readUInt32LE(at) !== 3) continue;
            const start = Number(bytes.readBigUInt64LE(at + 8)), length = Number(bytes.readBigUInt64LE(at + 32));
            if (!length || start + length > bytes.length) return [];
            const interpreter = bytes.subarray(start, start + length).toString('utf8');
            return interpreter.includes('musl') ? [`linux-${arch}-musl`] : /ld-linux|ld64/.test(interpreter) ? [`linux-${arch}-glibc`] : [];
        }
        return [`linux-${arch}-glibc`, `linux-${arch}-musl`];
    }
    if (bytes.length >= 8 && [0xcafebabe, 0xcafebabf].includes(bytes.readUInt32BE(0))) {
        const count = bytes.readUInt32BE(4), wide = bytes.readUInt32BE(0) === 0xcafebabf, size = wide ? 32 : 20;
        if (!count || count > 16 || 8 + count * size > bytes.length) return [];
        const targets = [];
        for (let index = 0; index < count; index++) {
            const at = 8 + index * size, offset = wide ? Number(bytes.readBigUInt64BE(at + 8)) : bytes.readUInt32BE(at + 8), length = wide ? Number(bytes.readBigUInt64BE(at + 16)) : bytes.readUInt32BE(at + 12);
            if (!length || offset < 8 + count * size || offset + length > bytes.length) return [];
            targets.push(...executableTargets(bytes.subarray(offset, offset + length), depth + 1));
        }
        return [...new Set(targets)];
    }
    if (bytes.length >= 32) {
        const magic = bytes.readUInt32LE(0);
        if (magic === 0xfeedfacf) {
            if (bytes.readUInt32LE(12) !== 2) return [];
            const commands = bytes.readUInt32LE(16), length = bytes.readUInt32LE(20);
            if (!commands || commands > 4096 || 32 + length > bytes.length) return [];
            let offset = 32;
            for (let index = 0; index < commands; index++) {
                if (offset + 8 > 32 + length) return [];
                const type = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4);
                if (size < 8 || offset + size > 32 + length) return [];
                if (type === 0x32 && (size < 24 || bytes.readUInt32LE(offset + 8) !== 1)) return [];
                offset += size;
            }
            const arch = { 0x1000007: 'x64', 0x100000c: 'arm64' }[bytes.readUInt32LE(4)];
            return arch ? ['darwin-' + arch] : [];
        }
    }
    if (bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
        const at = bytes.readUInt32LE(60);
        if (at + 44 > bytes.length || bytes.toString('ascii', at, at + 4) !== 'PE\0\0' || bytes.readUInt16LE(at + 22) & 0x2000 || !bytes.readUInt32LE(at + 40)) return [];
        const arch = { 0x8664: 'x64', 0xaa64: 'arm64' }[bytes.readUInt16LE(at + 4)];
        return arch ? ['win32-' + arch] : [];
    }
    return [];
}
async function jarMain(bytes) {
    const zip = await require('yauzl').fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
    try {
        return await new Promise((resolve, reject) => {
            let entries = 0;
            zip.on('error', reject); zip.on('end', () => resolve(false));
            zip.on('entry', entry => {
                if (++entries > 20000) { reject(new Error('JAR превышает лимит записей.')); return; }
                if (entry.fileName !== 'META-INF/MANIFEST.MF') { zip.readEntry(); return; }
                if (entry.uncompressedSize > 65536) { reject(new Error('Манифест JAR превышает 64 КиБ.')); return; }
                void zip.openReadStreamPromise(entry).then(async stream => {
                    let size = 0; const chunks = [];
                    for await (const chunk of stream) { size += chunk.length; if (size > 65536) throw new Error('Манифест JAR превышает 64 КиБ.'); chunks.push(chunk); }
                    const manifest = Buffer.concat(chunks);
                    if (manifest.length !== entry.uncompressedSize || crc32(manifest) !== entry.crc32) throw new Error('Манифест JAR повреждён.');
                    resolve(/^Main-Class:\s*\S+/m.test(manifest.toString('utf8')));
                }).catch(reject);
            });
            zip.readEntry();
        });
    } finally { zip.close(); }
}
async function payloadFiles(directory, prefix = '', result = []) {
    for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
        const relative = prefix ? prefix + '/' + entry.name : entry.name, filename = path.join(directory, relative), info = await fs.lstat(filename);
        if (!runtime.portablePath(relative) || info.isSymbolicLink() || !info.isFile() && !info.isDirectory() || info.nlink !== 1 && info.isFile()) throw new Error('В поставке запрещены ссылки и специальные файлы.');
        if (info.isDirectory()) { await payloadFiles(directory, relative, result); continue; }
        if (result.length >= runtime.LIMITS.filesCount || info.size > runtime.LIMITS.compressedBytes) throw new Error('Поставка превышает допустимый размер.');
        result.push({ path: relative, filename, size: info.size });
    }
    return result;
}
/** Ready bundles keep their runtime; static Python sources receive an explicitly pinned runtime plan. */
export async function detectReadyPayload(directory) {
    const files = await payloadFiles(directory), binaries = [], scripts = [], jars = [], dotnet = [], dotnetHosts = new Map();
    for (const file of files) {
        if (!file.size) continue;
        const relevant = !/\.(?:a|so(?:\.\d+)*|dylib|dll|pdb|lib|o|obj|class|json|md|txt|html|xml|png|jpg|svg|map)$/i.test(file.path);
        if (relevant) {
            const bytes = await fs.readFile(file.filename), targets = executableTargets(bytes);
            if (targets.length) binaries.push({ ...file, targets, adapter: bytes.includes(Buffer.from('Go build ID')) || bytes.includes(Buffer.from('go1.')) ? 'go' : bytes.includes(Buffer.from('rustc/')) ? 'rust' : 'native' });
            if (/\.py$/i.test(file.path) && file.size <= 1048576 && /(?:if\s+__name__\s*==\s*["']__main__["']|(?:^|\/)__main__\.py$)/m.test(bytes.toString('utf8') + '\n' + file.path)) scripts.push(file);
            if (/\.jar$/i.test(file.path) && await jarMain(bytes)) jars.push(file);
        }
        if (/\.runtimeconfig\.json$/i.test(file.path)) {
            const dll = files.find(item => item.path === file.path.replace(/\.runtimeconfig\.json$/i, '.dll'));
            if (dll?.size) {
                if (file.size > 65536) throw new Error('runtimeconfig .NET превышает 64 КиБ.');
                let config; try { config = JSON.parse(await fs.readFile(file.filename, 'utf8')); } catch { throw new Error('runtimeconfig .NET содержит некорректный JSON.'); }
                if (!config?.runtimeOptions || typeof config.runtimeOptions.tfm !== 'string' || !config.runtimeOptions.tfm) throw new Error('runtimeconfig .NET не описывает запускаемое приложение.');
                const bytes = await fs.readFile(dll.filename), at = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length;
                if (bytes.toString('ascii', 0, 2) !== 'MZ' || at + 248 > bytes.length || bytes.toString('ascii', at, at + 4) !== 'PE\0\0') throw new Error('Приложение .NET должно содержать готовую сборку DLL.');
                const optional = bytes.readUInt16LE(at + 24), directory = at + 24 + (optional === 0x20b ? 112 : optional === 0x10b ? 96 : bytes.length);
                if (directory + 120 > bytes.length || !bytes.readUInt32LE(directory + 112)) throw new Error('DLL не содержит managed .NET assembly.');
                dotnet.push(dll);
                const included = Array.isArray(config.runtimeOptions.includedFrameworks) && config.runtimeOptions.includedFrameworks.length > 0;
                const hostfxr=files.some(item=>/^(?:lib)?hostfxr\.(?:so|dylib|dll)$/i.test(path.posix.basename(item.path))),coreclr=files.some(item=>/^(?:lib)?coreclr\.(?:so|dylib|dll)$/i.test(path.posix.basename(item.path)));
                dotnetHosts.set(dll.path.replace(/\.dll$/i,''),included&&hostfxr&&coreclr);
            }
        }
    }
    const candidates = [];
    const runtimes = new Set(), runtimeRoots = new Set();
    for (const [adapter, apps, pattern] of [['python', scripts, /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i], ['java', jars, /^java(?:\.exe)?$/i], ['dotnet', dotnet, /^dotnet(?:\.exe)?$/i]]) {
        const matches = binaries.filter(file => pattern.test(path.posix.basename(file.path)));
        for (const runtime of matches) {runtimes.add(runtime.path);const bin=path.posix.dirname(runtime.path),root=path.posix.basename(bin)==='bin'?path.posix.dirname(bin):bin;runtimeRoots.add(root);}
        for (const app of apps) for (const runtime of matches) candidates.push({ entrypoint: app.path, runtimeEntrypoint: runtime.path, adapter, targets: runtime.targets });
    }
    for (const binary of binaries) {
        if ([...runtimeRoots].some(root=>root==='.'||binary.path.startsWith(root+'/'))) continue;
        const host=binary.path.replace(/\.exe$/i,'');
        if(dotnetHosts.has(host)&&!dotnetHosts.get(host))continue;
        if (runtimes.has(binary.path) || /(?:^|\/)(?:java|python[\d.]*|dotnet)(?:\.exe)?$/i.test(binary.path)) continue;
        candidates.push({ entrypoint: binary.path, adapter: binary.adapter, targets: binary.targets });
    }
    if (!candidates.length) candidates.push(...await inspectPythonSource(directory,files));
    if (!candidates.length) {
        const languages = [scripts.length && 'Python', jars.length && 'Java', dotnet.length && '.NET'].filter(Boolean);
        throw new Error(languages.length ? `В поставке ${languages.join(', ')} нет встроенного runtime. Выберите автономную поставку.` : 'В архиве не найден готовый исполняемый файл поддерживаемой платформы. Исходники JS/TS добавляются по ссылке репозитория; для других языков нужен готовый релиз.');
    }
    const unique = new Map(candidates.map(candidate => [candidate.entrypoint + '\0' + (candidate.runtimeEntrypoint ?? ''), candidate]));
    return [...unique.values()];
}

/** Downloads, validates and inspects bytes only. No upstream installation scripts or executables run. */
export async function inspectGithubReleaseAsset(asset, selected, { cacheDirectory = path.join(os.tmpdir(), 'neurocenter-release-cache'), transport, downloadAsset } = {}) {
    const downloaded = downloadAsset ? await downloadAsset(asset) : await downloadRuntimeCandidate(asset, cacheDirectory, transport);
    const actual = await fs.lstat(downloaded.filename);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.size !== asset.bytes || actual.size !== downloaded.compressedBytes) throw new Error('Размер файла релиза не совпал с метаданными GitHub.');
    const hash = createHash('sha256');
    const handle = await fs.open(downloaded.filename, 'r');
    try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); } finally { await handle.close(); }
    if (hash.digest('hex') !== downloaded.sha256 || asset.sha256 && asset.sha256 !== downloaded.sha256) throw new Error('SHA-256 файла релиза не совпал.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-release-inspection-'));
    try {
        if (asset.format === 'file') await fs.copyFile(downloaded.filename, path.join(directory, asset.name));
        else await extractRelease(downloaded.filename, asset, directory);
        const choices = await detectReadyPayload(directory);
        const names = [...new Set(choices.map(choice => choice.entrypoint))];
        const matching=selected?choices.filter(choice=>choice.entrypoint===selected||choice.python&&pythonEntrypointFiles(choice.python).includes(selected)):choices;
        const chosen = matching.length===1 ? matching[0] : undefined;
        if (selected && !matching.length) throw new Error('Выбранный исполняемый файл отсутствует в проверенной поставке.');
        if(selected&&matching.length>1&&new Set(matching.map(choice=>choice.entrypoint)).size===1)throw new Error('Для приложения найдено несколько runtime. Выберите архив с одним встроенным runtime.');
        if (chosen && choices.filter(choice => choice.entrypoint === chosen.entrypoint).length > 1) throw new Error('Для приложения найдено несколько runtime. Выберите архив с одним встроенным runtime.');
        const description=await payloadDescription(directory,chosen?[chosen]:choices);
        const common = { sha256: downloaded.sha256, entrypoint: chosen?.entrypoint ?? '', candidates: names, executableChoices: choices, warnings: [],...(chosen?.python?.distribution?{name:chosen.python.distribution.name.slice(0,128)}:{}),...(description?{description}:{}) };
        if (!chosen) return common;
        const app = { url: asset.url, sha256: downloaded.sha256, format: asset.format, entrypoint: chosen.entrypoint };
        const assets = Object.fromEntries(chosen.targets.map(target => [target, { app, ...(chosen.python?{runtime:chosen.runtimeAssets[target]}:chosen.runtimeEntrypoint ? { runtime: { ...app, entrypoint: chosen.runtimeEntrypoint } } : {}) }]));
        return { ...common, runtimeSource: { type: 'runtime', adapter: chosen.adapter, assets,...(chosen.python?{python:chosen.python}:{}) } };
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** A ready repository payload is inspected from its immutable codeload snapshot, without a hand-authored recipe. */
export async function inspectGithubRepository(source, selected, { cacheDirectory = path.join(os.tmpdir(), 'neurocenter-repository-cache'), downloadArchive } = {}) {
    const { downloadRepositoryArchive, repositoryRoot } = await import('./repository-source.mjs');
    const archive = downloadArchive ? await downloadArchive(source) : await downloadRepositoryArchive({ ...source, entrypoint: 'index.js' }, cacheDirectory);
    const root = await repositoryRoot(archive.archivePath, source);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-repository-inspection-'));
    try {
        await extractRelease(archive.archivePath, { format: 'tar.gz' }, temporary);
        const directory = path.join(temporary, root, source.subdirectory ?? ''), choices = await detectReadyPayload(directory);
        const candidates = [...new Set(choices.map(choice => choice.entrypoint))];
        const matching=selected?choices.filter(choice=>choice.entrypoint===selected||choice.python&&pythonEntrypointFiles(choice.python).includes(selected)):choices;
        const chosen = matching.length===1 ? matching[0] : undefined;
        if (selected && !matching.length) throw new Error('Выбранный исполняемый файл отсутствует в закреплённом репозитории.');
        if(selected&&matching.length>1&&new Set(matching.map(choice=>choice.entrypoint)).size===1)throw new Error('Для приложения найдено несколько встроенных runtime. Выберите поставку с одним runtime.');
        if (chosen && choices.filter(choice => choice.entrypoint === chosen.entrypoint).length > 1) throw new Error('Для приложения найдено несколько встроенных runtime. Выберите поставку с одним runtime.');
        const description=await payloadDescription(directory,chosen?[chosen]:choices);
        const common = { snapshotSha256: archive.sha256, entrypoint: chosen?.entrypoint ?? '', candidates, requiresEntrypointChoice: !chosen, recommendedKind: 'mcp', runnableKinds: ['mcp'], warnings: [],...(chosen?.python?.distribution?{name:chosen.python.distribution.name.slice(0,128)}:{}),...(description?{description}:{}) };
        if (!chosen) return common;
        const app = { directory: '.', entrypoint: chosen.entrypoint };
        const assets = Object.fromEntries(chosen.targets.map(target => [target, { app, ...(chosen.python?{runtime:chosen.runtimeAssets[target]}:chosen.runtimeEntrypoint ? { runtime: { directory: '.', entrypoint: chosen.runtimeEntrypoint } } : {}) }]));
        return { ...common, adapter: chosen.adapter, supportedTargets: chosen.targets, runtimeSource: { type: 'runtime', adapter: chosen.adapter, assets,...(chosen.python?{python:chosen.python}:{}) } };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
