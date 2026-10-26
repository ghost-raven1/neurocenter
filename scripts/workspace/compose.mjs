import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,open,lstat,link,readlink,symlink,rename,rm,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {withBuildNetwork} from './npm-build-environment.mjs';

export const composeLock = JSON.parse(readFileSync(new URL('./compose.lock.json', import.meta.url), 'utf8'));

/** Автоматическая установка использует только закреплённый выпуск нужной платформы. */
export function composeAsset(platform, arch, lock = composeLock) {
    const asset = lock.assets[`${platform}-${arch}`];
    if (!asset) throw new Error('Автоматическая установка Compose поддерживает macOS/Linux на arm64 и x64. Установите плагин docker compose для своей платформы.');
    return asset;
}

function docker(args, env) {
    return spawnSync('docker', args, {env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536, windowsHide: true});
}

function requireDocker(env) {
    if (docker(['--version'], env).status !== 0) throw new Error('Не найден Docker CLI. Установите Docker Desktop для macOS или Docker Engine с CLI для Linux, затем повторите установку.');
}

/** Подходит современный Compose-плагин, включая новые major; CLI v1 не используется. */
export function composeVersion(env = process.env) {
    const result = docker(['compose', 'version', '--short'], env);
    const version = result.stdout?.trim();
    const match = version?.match(/^v?(\d+)\.\d+\.\d+(?:[-+]\S+)?$/);
    if (result.status !== 0 || !match || Number(match[1]) < 2) return null;
    const help = docker(['compose', 'up', '--help'], env);
    return help.status === 0 && /--wait(?:\s|$)/.test(help.stdout) && /--wait-timeout\b/.test(help.stdout) ? version.replace(/^v/, '') : null;
}

/** Запуск останавливается до сборки, если Docker/Compose или daemon недоступны. */
export function checkCompose(env = process.env) {
    requireDocker(env);
    if (!composeVersion(env)) throw new Error('Нужен Compose v2 или новее с up --wait. Выполните scripts/dev.sh install или npm run compose:install.');
    if (docker(['info', '--format', '{{.ServerVersion}}'], env).status !== 0) throw new Error('Docker Engine недоступен. Запустите Docker Desktop или Docker daemon и повторите запуск.');
}

async function download(asset, filename, fetchImpl) {
    return withBuildNetwork(async () => {
    const handle = await open(filename, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    try {
        const response = await fetchImpl(asset.url, {signal: AbortSignal.timeout(180000), redirect: 'follow'});
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error(`Не удалось скачать Compose: HTTP ${response.status}. Повторите установку.`);
        }
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > asset.size) throw new Error('Размер скачанного Compose превышает закреплённый. Установка остановлена.');
            hash.update(chunk); await handle.writeFile(chunk);
        }
    } catch (error) {
        if (['TimeoutError', 'AbortError'].includes(error.name)) throw new Error('Загрузка Compose превысила время ожидания. Повторите установку.');
        if (error instanceof TypeError) throw new Error('Не удалось скачать Compose. Проверьте подключение к GitHub и повторите установку.');
        throw error;
    } finally {await handle.close();}
    if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('SHA-256 или размер Compose не совпали с закреплённым выпуском. Установка остановлена.');
    await chmod(filename, 0o755);
    });
}

/** Устанавливает пользовательский CLI-плагин, сохраняя config.json, credentials и прежний бинарник при отказе. */
export async function ensureCompose({env = process.env, platform = process.platform, arch = process.arch, fetchImpl = fetch, lock = composeLock} = {}) {
    requireDocker(env);
    const existing = composeVersion(env);
    if (existing) {console.log(`Docker Compose ${existing} уже установлен.`); return {installed: false, version: existing};}
    const asset = composeAsset(platform, arch, lock);
    const directory = path.join(path.resolve(env.DOCKER_CONFIG || path.join(homedir(), '.docker')), 'cli-plugins');
    await mkdir(directory, {recursive: true, mode: 0o700});
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог Docker cli-plugins должен быть обычным каталогом без символической ссылки.');
    const controlFile = path.join(directory, '.neurocenter-compose.lock');
    let control;
    try {control = await open(controlFile, 'wx', 0o600);}
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new Error('Установка Compose уже выполняется. Дождитесь её завершения; после аварии проверьте .neurocenter-compose.lock.');
    }
    const temporary = path.join(directory, `.docker-compose.${randomUUID()}.download`);
    const backup = temporary + '.previous';
    const target = path.join(directory, 'docker-compose');
    let backupMade = false, published = false, success = false;
    try {
        await control.writeFile(String(process.pid));
        // Повторная проверка после захвата исключает лишнюю загрузку при последовательных install.
        const ready = composeVersion(env);
        if (ready) return {installed: false, version: ready};
        console.log(`Устанавливаем Docker Compose ${lock.version} для ${platform}/${arch}…`);
        await download(asset, temporary, fetchImpl);
        const probe = spawnSync(temporary, ['version', '--short'], {env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536});
        if (probe.status !== 0 || probe.stdout.trim().replace(/^v/, '') !== lock.version) throw new Error('Скачанный Compose не запустился или сообщил другую версию. Прежний плагин сохранён.');
        let previous;
        try {previous = await lstat(target);} catch (error) {if (error.code !== 'ENOENT') throw error;}
        if (previous) {
            if (!previous.isFile() && !previous.isSymbolicLink()) throw new Error('На месте Docker Compose находится посторонний каталог или специальный файл.');
            if (previous.isSymbolicLink()) await symlink(await readlink(target), backup);
            else await link(target, backup);
            backupMade = true;
        }
        await rename(temporary, target); published = true;
        const version = composeVersion(env);
        if (!version) throw new Error('Docker CLI не видит установленный Compose. Проверьте DOCKER_CONFIG и cliPluginsExtraDirs в конфигурации Docker.');
        success = true;
        console.log(`Docker Compose ${version} готов. Плагин: ${target}`);
        return {installed: true, version, target};
    } catch (error) {
        if (published) {
            if (backupMade) {await rename(backup, target); backupMade = false;}
            else await rm(target, {force: true});
        }
        throw error;
    } finally {
        try {
            await rm(temporary, {force: true});
            if (success || !published) await rm(backup, {force: true});
        } finally {await control.close(); await rm(controlFile, {force: true});}
    }
}
