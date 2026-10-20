import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBridgeBuild} from './bridge-build-integrity.mjs';
import {opencodeVersion, opencodePackageName} from './opencode-platforms.mjs';
import {bridgeRuntimeCached, publishBridgeRuntimeFiles, validateBridgeRuntimeRelease} from './bridge-runtime-artifacts.mjs';
import {serializeAsset, validateAsset} from '@neurocenter/asset-contract';

const root = fileURLToPath(new URL('../', import.meta.url));
const bridge = path.join(root, 'mcp/neurocenter-asset-sync');
const output = path.join(root, 'bridge-dist/runtime');
const supported = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64',
    'linux-arm64-musl', 'linux-x64-musl', 'windows-arm64', 'windows-x64'];
const hostPlatform = process.platform === 'win32' ? 'windows' : process.platform;
const hostMusl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const host = `${hostPlatform}-${process.arch}${hostMusl ? '-musl' : ''}`;
const nativeNodeSupported = Number(process.versions.node.split('.')[0]) === 24;

/** Принимаем только согласованный комплект текущей сборки и закреплённого движка. */
function cached(target, version, buildId, directory = output, metadata) {
    return bridgeRuntimeCached({directory, target, version, buildId, metadata});
}

/** Предыдущий комплект сохраняется до публикации; ошибка любого rename откатывает всю тройку. */
async function publish(candidate, previous, target, version) {
    const name = `neurocenter-asset-sync-${target}-${version}.tgz`;
    await publishBridgeRuntimeFiles({candidate, previous, directory: output, files: [name, name + '.sha256', name + '.json']});
}

/** Копируем только открытые входные файлы; пользовательские настройки в контейнер не попадают. */
async function dockerBuild(target, archiveName, candidate) {
    const dockerfile = await fs.readFile(path.join(root, 'services/api-gateway/Dockerfile'), 'utf8');
    const image = dockerfile.match(/^ARG NODE_IMAGE=(node:24\.22\.0-bookworm-slim@sha256:[a-f0-9]{64})\r?$/m)?.[1];
    if (!image) { throw new Error('Не найден закреплённый образ Node.js 24.22.0 для сборки моста.'); }
    await fs.mkdir(path.join(root, '.run'), {recursive: true});
    const temporary = await fs.mkdtemp(path.join(root, '.run/bridge-runtimes-'));
    const workspace = path.join(temporary, 'workspace');
    try {
        for (const directory of ['scripts/workspace', 'mcp/neurocenter-asset-sync', 'bridge-dist/opencode', 'bridge-dist/runtime']) {
            await fs.mkdir(path.join(workspace, directory), {recursive: true});
        }
        for (const name of ['package-bridge-runtime.mjs', 'bridge-build-integrity.mjs', 'bridge-runtime-probe.mjs',
            'bridge-windows-job.mjs', 'opencode-platforms.mjs', 'workspace/node-runtime.mjs']) {
            await fs.copyFile(path.join(root, 'scripts', name), path.join(workspace, 'scripts', name));
        }
        for (const name of ['dist', 'package.json', 'package-lock.json']) {
            await fs.cp(path.join(bridge, name), path.join(workspace, 'mcp/neurocenter-asset-sync', name), {recursive: true});
        }
        for (const name of [archiveName, archiveName + '.sha256']) {
            await fs.copyFile(path.join(root, 'bridge-dist/opencode', name), path.join(workspace, 'bridge-dist/opencode', name));
        }
        const args = ['run', '--rm', '--platform', target === 'linux-x64' ? 'linux/amd64' : 'linux/arm64',
            '--workdir', '/workspace', '--volume', `${workspace}:/workspace:ro`,
            '--volume', `${candidate}:/workspace/bridge-dist/runtime:rw`,
            '--env', 'HOME=/tmp', '--env', 'npm_config_cache=/tmp/npm-cache',
            '--env', 'BRIDGE_RUNTIME_OUTPUT_DIR=/workspace/bridge-dist/runtime'];
        if (typeof process.getuid === 'function') { args.push('--user', `${process.getuid()}:${process.getgid()}`); }
        args.push(image, 'node', '/workspace/scripts/package-bridge-runtime.mjs');
        execFileSync('docker', args, {stdio: 'inherit', cwd: root});
    } finally { await fs.rm(temporary, {recursive: true, force: true}); }
}

/** Один запуск готовит недостающие цели, повторный использует проверенные архивы без сети. */
async function main() {
    let selected = process.env.BRIDGE_RUNTIME_TARGETS;
    let helper;
    let targetOption = false;
    let help = false;
    for (const argument of process.argv.slice(2)) {
        if (argument === '--help' && !help) { help = true; }
        else if (argument.startsWith('--targets=') && !targetOption) { selected = argument.slice('--targets='.length); targetOption = true; }
        else if (argument.startsWith('--windows-job-helper=') && !helper) { helper = argument; }
        else { throw new Error(`Неизвестный или повторный параметр: ${argument}`); }
    }
    if (help) {
        console.log('Подготовка автономного моста: node scripts/prepare-bridge-runtimes.mjs [--targets=darwin-arm64,linux-x64] [--windows-job-helper=файл]');
        return;
    }
    const manifest = JSON.parse(await fs.readFile(path.join(bridge, 'package.json'), 'utf8'));
    const build = await verifyBridgeBuild(path.join(bridge, 'dist'), manifest.version);
    const targets = [...new Set(selected === undefined ? [host, 'linux-x64'] : selected.split(',').map(value => value.trim()))].sort();
    if (!targets.length || targets.some(target => !supported.includes(target))) { throw new Error(`Неизвестные цели моста: ${targets.join(', ')}. Поддерживаются: ${supported.join(', ')}.`); }
    if (await exportedAsset(targets, manifest.version, build.buildId)) { return; }
    const missing = [];
    for (const target of targets) {
        if (await cached(target, manifest.version, build.buildId, output)) { console.log(`Мост ${target}: готов, контрольная сумма проверена.`); }
        else { missing.push(target); }
    }
    for (const target of missing) {
        if (target !== host && !['linux-x64', 'linux-arm64'].includes(target)) {
            throw new Error(`Мост ${target}: отсутствует готовый пакет; сборка нужна на целевой ОС/архитектуре. Автоматическая кросс-сборка этой цели недоступна.`);
        }
        if (target === host && !nativeNodeSupported && !['linux-x64', 'linux-arm64'].includes(target)) {
            throw new Error(`Мост ${target}: нативная упаковка требует Node.js 24. Запустите эту команду через Node.js 24; текущая версия ${process.versions.node}.`);
        }
    }
    await fs.mkdir(output, {recursive: true});
    await fs.mkdir(path.join(root, '.run'), {recursive: true});
    const lock = path.join(root, '.run/bridge-runtimes.lock');
    try { await fs.mkdir(lock); }
    catch (error) {
        if (error.code !== 'EEXIST') { throw error; }
        throw new Error(`Подготовка автономного моста уже выполняется. Повторите после её завершения. Если процесс завершён, проверьте оставшуюся блокировку: ${lock}`);
    }
    try {
        if (await exportedAsset(targets, manifest.version, build.buildId)) { return; }
        for (const target of missing) {
            if (await cached(target, manifest.version, build.buildId, output)) {
                console.log(`Мост ${target}: готов, контрольная сумма проверена.`);
                continue;
            }
            console.log(`Мост ${target}: подготавливаем автономный пакет…`);
            const [platform, arch, libc] = target.split('-');
            const packageName = opencodePackageName(platform === 'windows' ? 'win32' : platform, arch, libc === 'musl');
            execFileSync(process.execPath, [path.join(root, 'scripts/prepare-opencode.mjs')], {
                stdio: 'inherit', cwd: root,
                env: {...process.env, OPENCODE_TARGETS: packageName.slice('opencode-'.length), OPENCODE_VERSION: opencodeVersion},
            });
            const temporary = await fs.mkdtemp(path.join(root, '.run/bridge-runtime-candidate-'));
            const candidate = path.join(temporary, 'result');
            let keepTemporary = false;
            try {
                await fs.mkdir(candidate);
                if (target === host && nativeNodeSupported) {
                    execFileSync(process.execPath, [path.join(root, 'scripts/package-bridge-runtime.mjs'), ...(helper ? [helper] : [])], {
                        stdio: 'inherit', cwd: root, env: {...process.env, BRIDGE_RUNTIME_OUTPUT_DIR: candidate},
                    });
                } else { await dockerBuild(target, `${packageName}-${opencodeVersion}.tgz`, candidate); }
                if (!await cached(target, manifest.version, build.buildId, candidate)) { throw new Error(`Мост ${target}: собранный пакет не прошёл проверку версии, сборки и SHA-256.`); }
                await publish(candidate, path.join(temporary, 'previous'), target, manifest.version);
            } catch (error) { keepTemporary = error.keepTemporary === true; throw error; }
            finally { if (!keepTemporary) { await fs.rm(temporary, {recursive: true, force: true}); } }
            console.log(`Мост ${target}: автономный пакет готов и проверен.`);
        }
        await exportAsset(targets, manifest.version, build.buildId);
    } finally {
        await fs.rmdir(lock);
    }
}

/** Экспортированная версия неизменяема, включая набор платформ и все байты runtime. */
async function exportedAsset(targets, version, buildId) {
    const filename = path.join(output, `neurocenter-bridge-${version}.asset.json`);
    let handle;
    try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') { return false; } throw error; }
    let asset;
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) { throw new Error('Descriptor моста занят посторонними данными.'); }
        asset = validateAsset(JSON.parse(await handle.readFile('utf8')));
    } finally { await handle.close(); }
    const release = validateBridgeRuntimeRelease(asset.delivery.release);
    if (asset.id !== 'neurocenter-bridge' || asset.kind !== 'bridge' || asset.version !== version
        || asset.source.repository !== 'https://github.com/ghost-raven1/neurocenter-assets'
        || release.buildId !== buildId || release.artifacts.map(item => item.metadata.target).sort().join(',') !== targets.join(',')) {
        throw new Error('Версия ассета моста уже экспортирована с другой сборкой или набором платформ. Увеличьте версию моста.');
    }
    for (const artifact of release.artifacts) {
        if (!await cached(artifact.metadata.target, version, buildId, output, artifact.metadata)) {
            throw new Error('Файлы экспортированной версии моста повреждены. Восстановите закреплённые байты или подготовьте новую версию.');
        }
    }
    console.log(`Ассет моста ${version}: descriptor и архивы проверены.`);
    return true;
}

/** Сборщик создаёт тот же source descriptor, который принимает импорт каталога. */
async function exportAsset(targets, version, buildId) {
    const repository='https://github.com/ghost-raven1/neurocenter-assets',tag='bridge-v'+version;
    const artifacts=[];
    for(const target of targets){
        const file=`neurocenter-asset-sync-${target}-${version}.tgz`;
        const metadata=JSON.parse(await fs.readFile(path.join(output,file+'.json'),'utf8'));
        artifacts.push({file,url:`${repository}/releases/download/${tag}/${file}`,metadata});
    }
    const release=validateBridgeRuntimeRelease({schemaVersion:1,version,buildId,release:tag,artifacts});
    const asset={schemaVersion:1,id:'neurocenter-bridge',kind:'bridge',version,source:{type:'release',repository,tag},license:{spdx:'NOASSERTION'},
        compatibility:{bridgeProtocol:2},card:{name:'Neurocenter Bridge',description:'Мост для подключения компьютера к Нейроцентру.'},delivery:{type:'bridge-release',release}};
    const bytes=serializeAsset(asset),filename=path.join(output,`neurocenter-bridge-${version}.asset.json`);
    const staging = await fs.mkdtemp(path.join(output, '.asset-export-'));
    try {
        const candidate = path.join(staging, 'descriptor.json');
        await fs.writeFile(candidate, bytes, {flag: 'wx', mode: 0o400});
        await fs.link(candidate, filename);
    } finally { await fs.rm(staging, {recursive: true, force: true}); }
    console.log(`Descriptor ассета: ${filename}`);
}

main().catch(error => { console.error(`Ошибка подготовки моста: ${error.message}`); process.exitCode = 1; });
