import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {verifyBridgeBuild} from '../bridge-build-integrity.mjs';
import {bridgeRuntimeCached} from '../bridge-runtime-artifacts.mjs';
import {opencodePackageName} from '../opencode-platforms.mjs';

/** Only the host runtime is prepared; development never republishes an immutable release. */
export function devBridgeTarget(platform = process.platform, arch = process.arch, musl = platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime) {
    const os = {darwin: 'darwin', linux: 'linux'}[platform];
    if (!os || !['arm64', 'x64'].includes(arch)) throw new Error('dev.sh install поддерживает мост на macOS и Linux (arm64/x64).');
    return `${os}-${arch}${musl ? '-musl' : ''}`;
}

/** A failing child stops installation before publication or replacement of an installed bridge. */
function execute(command, args, options) {
    const result = spawnSync(command, args, {...options, stdio: 'inherit', timeout: 20 * 60_000});
    if (result.error) throw result.error;
    if (result.status !== 0) {
        const reason = result.signal ? `остановлен сигналом ${result.signal}` : `завершился с кодом ${result.status}`;
        throw new Error(`Подготовка моста: ${path.basename(args[0])} ${reason}.`);
    }
}

/** Publish one verified generation with a single rename; requests already using the previous one remain valid. */
export async function prepareDevBridge({root, node = process.execPath, environment = process.env, output, run = execute, updateInstalled} = {}) {
    const target = devBridgeTarget(), bridge = path.join(root, 'mcp/neurocenter-asset-sync');
    const directory = path.join(root, '.run/dev-bridge/runtime'), lock = path.join(root, '.run/dev-bridge/install.lock');
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    if (await fs.realpath(directory) !== directory) throw new Error('Каталог dev-поставки моста должен находиться в checkout без символических ссылок.');
    try { await fs.mkdir(lock, {mode: 0o700}); }
    catch (error) {
        if (error.code === 'EEXIST') throw new Error(`Обновление dev-моста уже выполняется. Проверьте PID в ${lock}/owner.pid перед удалением оставшейся блокировки.`);
        throw error;
    }
    let generation, pointer, pointerCreated = false, published = false, failure;
    try {
        await fs.writeFile(path.join(lock, 'owner.pid'), `${process.pid}\n`, {mode: 0o600});
        const env = {...environment, NODE_BIN: node, PATH: path.dirname(node) + path.delimiter + (environment.PATH || '')};
        output?.info('Мост', 'Сборка текущих исходников и автономного пакета для этого компьютера');
        await run(node, [path.join(bridge, 'scripts/build.mjs')], {cwd: root, env});
        const {version} = JSON.parse(await fs.readFile(path.join(bridge, 'package.json'), 'utf8'));
        const {buildId} = await verifyBridgeBuild(path.join(bridge, 'dist'), version);
        const commit = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8', timeout: 10000});
        const sourceCommit = commit.stdout?.trim();
        if (commit.error || commit.status !== 0 || !/^[a-f0-9]{40}$/.test(sourceCommit || '')) throw new Error('Не удалось определить ревизию исходников dev-моста.');
        await run(node, [path.join(root, 'scripts/prepare-opencode.mjs')], {cwd: root, env: {...env, OPENCODE_VERSION: undefined,
            OPENCODE_TARGETS: opencodePackageName(process.platform, process.arch, target.endsWith('-musl')).slice('opencode-'.length)}});
        generation = await fs.mkdtemp(path.join(directory, 'generation-'));
        await run(node, [path.join(root, 'scripts/package-bridge-runtime.mjs')], {cwd: root, env: {...env, BRIDGE_RUNTIME_OUTPUT_DIR: generation}});
        if (!await bridgeRuntimeCached({directory: generation, target, version, buildId})) throw new Error('Автономный dev-мост не прошёл проверку версии, сборки и SHA-256. Прежняя поставка сохранена.');
        const archive = path.join(generation, `neurocenter-asset-sync-${target}-${version}.tgz`);
        pointer = path.join(directory, `.current-${process.pid}.json`);
        const file = await fs.open(pointer, 'wx', 0o600); pointerCreated = true;
        try {
            await file.writeFile(JSON.stringify({version, target, buildId, sourceCommit, directory: path.basename(generation)}) + '\n');
            await file.sync();
        } finally { await file.close(); }
        await fs.rename(pointer, path.join(directory, 'current.json'));
        published = true;
        output?.success(`Dev-поставка моста ${version} · ${buildId.slice(0, 12)} готова`);
        const installed = updateInstalled
            ? await updateInstalled({root, archive, version, buildId, target, environment: env, node, output})
            : {updated: false, reason: 'server-start-pending'};
        if (!updateInstalled) output?.info('Установленный мост', 'Установленный мост обновится после запуска сервера: scripts/dev.sh up');
        return {version, buildId, target, directory, installed};
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        // Cleanup is best effort for every owned path; one failure must not strand the install lock.
        const cleanup = [pointerCreated && pointer, generation && !published && generation, lock].filter(Boolean), errors = [];
        for (const file of cleanup) {
            try { await fs.rm(file, {recursive: file !== pointer, force: true}); }
            catch (error) { errors.push(`${file}: ${error.message}`); }
        }
        if (errors.length) {
            const message = 'Не удалось очистить временные файлы dev-моста: ' + errors.join('; ');
            if (failure) failure.message += ' ' + message;
            else throw new Error(message);
        }
    }
}
