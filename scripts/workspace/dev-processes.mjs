import {spawnSync} from 'node:child_process';
import {readFileSync, readlinkSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

const inspectionEnv = {...process.env, LC_ALL: 'C.UTF-8', TZ: 'UTC'};

/** Неусечённые сведения о процессе; UTF-8 сохраняет пути с кириллицей на macOS. */
function inspect(pid, field) {
    const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', field], {
        env: inspectionEnv, encoding: 'utf8', timeout: 1000,
    });
    return result.status === 0 ? result.stdout.trim() : '';
}

/** Время старта и команда защищают сохранённый PID от повторного использования. */
export function devProcessIdentity(pid) {
    return Number.isSafeInteger(pid) && pid > 0 ? inspect(pid, 'lstart=,command=') : '';
}

/** Точка входа сервиса внутри конкретного checkout. */
export function devServiceEntry(root, service) {
    return path.join(root, service.dir, service.name === 'frontend' ? 'node_modules/vite/bin/vite.js' : 'dist/main.js');
}

/** Поддерживаем прямой запуск, Nest CLI и npm/Vite из каталога сервиса. */
function matchesServiceCommand(command, root, service, executable, pid) {
    const entries = service.name === 'frontend'
        ? ['node_modules/vite/bin/vite.js', 'node_modules/.bin/vite']
        : ['dist/main.js', 'dist/main'];
    if (executable) {
        let script;
        if (process.platform === 'linux') {
            const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(1).filter(Boolean);
            if (args[0] === '--enable-source-maps') { args.shift(); }
            if (args.length !== 1) { return false; }
            [script] = args;
        } else {
            const prefix = [executable, path.basename(executable)].find(binary => command.startsWith(`${binary} `));
            if (!prefix) { return false; }
            script = command.slice(prefix.length + 1);
            if (script.startsWith('--enable-source-maps ')) { script = script.slice('--enable-source-maps '.length); }
            // ps не экранирует аргументы: дополнительный путь или существующий файл перед пробелом неоднозначен.
            if (/\s(?:\/|\.\.?\/)/.test(script)) { return false; }
            for (let space = script.indexOf(' '); space >= 0; space = script.indexOf(' ', space + 1)) {
                try { if (statSync(script.slice(0, space)).isFile()) { return false; } }
                catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) { return false; } }
            }
        }
        return entries.some(entry => script === entry || script === `./${entry}`
            || script === path.join(root, service.dir, entry)
            || path.isAbsolute(script) && script.endsWith(`/${path.join(service.dir, entry)}`));
    }
    return entries.some(entry => command.endsWith(` ${path.join(root, service.dir, entry)}`)
        || command.endsWith(`/${path.join(service.dir, entry)}`)
        || command.endsWith(` ${entry}`) || command.endsWith(` ./${entry}`));
}

/** Рабочий каталог ОС сохраняет актуальный путь после переименования checkout. */
function processDirectory(pid) {
    if (process.platform === 'linux') { return realpathSync(`/proc/${pid}/cwd`); }
    const result = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        env: inspectionEnv, encoding: 'utf8', timeout: 1000,
    });
    if (result.status !== 0) { return ''; }
    return result.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
}

/** Останавливаем только процессы своего каталога, включая записи до переноса проекта. */
export function ownsDevProcess(record, root, service) {
    if (!service || !Number.isSafeInteger(record.pid) || record.pid <= 0) { return false; }
    try {
        const identity = devProcessIdentity(record.pid);
        if (!identity || realpathSync(processDirectory(record.pid)) !== realpathSync(path.join(root, service.dir))) { return false; }
        if (record.identity) { return record.identity === identity; }
        // Старый формат не содержит identity: проверяем настоящий executable и точку входа.
        // В Linux имя потока Node 24 (comm) может быть MainThread вместо node.
        const executable = process.platform === 'linux'
            ? readlinkSync(`/proc/${record.pid}/exe`).replace(/ \(deleted\)$/, '')
            : inspect(record.pid, 'comm=');
        if (!['node', 'nodejs', path.basename(process.execPath)].includes(path.basename(executable))) { return false; }
        const command = inspect(record.pid, 'command=');
        return matchesServiceCommand(command, root, service, executable, record.pid);
    } catch { return false; }
}

/** Восстанавливаем потерянные PID только по известной команде Node и cwd своего checkout. */
export function discoverDevProcesses(root, services, excludedPids = []) {
    const result = spawnSync('ps', ['-ax', '-ww', '-o', 'pid=,command='], {
        env: inspectionEnv, encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.status !== 0) { throw new Error('Не удалось проверить прежние сервисы через ps. Перезапуск остановлен.'); }
    const excluded = new Set(excludedPids);
    const records = [];
    for (const line of result.stdout.split('\n')) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match) { continue; }
        const pid = Number(match[1]);
        if (pid === process.pid || excluded.has(pid)) { continue; }
        for (const service of services) {
            if (!matchesServiceCommand(match[2], root, service)) { continue; }
            const record = {name: service.name, pid};
            if (!ownsDevProcess(record, root, service)) { continue; }
            const identity = devProcessIdentity(pid);
            if (identity) { records.push({...record, identity}); }
            break;
        }
    }
    return records;
}
