import {spawnSync} from 'node:child_process';
import {realpathSync} from 'node:fs';
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
        const executable = path.basename(inspect(record.pid, 'comm='));
        if (!['node', 'nodejs', path.basename(process.execPath)].includes(executable)) { return false; }
        const command = inspect(record.pid, 'command=');
        const entry = devServiceEntry(root, service);
        const suffix = path.join(service.dir, path.relative(path.join(root, service.dir), entry));
        return command.endsWith(` ${entry}`) || command.endsWith(`/${suffix}`);
    } catch { return false; }
}
