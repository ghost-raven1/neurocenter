'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { resources, maxAgeMs } = require('./capacity.cjs');
const destination = '/capacity/snapshot.json';
function safeNumber(value) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('unsupported size');
    }
    return Number(value);
}

/** Кумулятивные jiffies /proc/stat между тиками (модульное состояние переживает 15s-тик). */
let previousCpu = null;
function readMeminfo(props = {}) {
    const file = props.meminfoPath || '/proc/meminfo';
    return fs.readFile(file, 'utf8').then((text) => {
        const value = (key) => {
            const match = text.match(new RegExp('^' + key + ':\\s+(\\d+)\\s+kB', 'm'));
            return match ? Number(match[1]) : null;
        };
        const memTotal = value('MemTotal');
        if (memTotal == null || memTotal <= 0) {
            throw new Error('machine meminfo');
        }
        // MemAvailable отсутствует на старых ядрах — консервативный запас из MemFree/Buffers/Cached.
        const memAvailable = value('MemAvailable') ?? value('MemFree') + value('Buffers') + value('Cached');
        if (memAvailable == null) {
            throw new Error('machine meminfo available');
        }
        return { ramTotalBytes: memTotal * 1024, ramAvailableBytes: memAvailable * 1024 };
    });
}
function readCpuStat(props = {}) {
    const file = props.statPath || '/proc/stat';
    return fs.readFile(file, 'utf8').then((text) => {
        const line = text.split('\n').find((entry) => entry.startsWith('cpu '));
        if (!line) {
            throw new Error('machine cpu stat');
        }
        const fields = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
        // linux /proc/stat: user nice system idle iowait irq softirq steal guest guest_nice;
        // guest/guest_nice уже учтены в user/nice, поэтому не суммируются повторно.
        const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
        const total = user + nice + system + idle + iowait + irq + softirq + steal;
        if (total <= 0) {
            throw new Error('machine cpu stat');
        }
        return { idles: idle + iowait, total };
    });
}

/** AD-18: host-RAM/CPU из /proc (не маскируются docker'ом, network_mode none + DAC_OVERRIDE). */
async function collectMachine(props = {}) {
    const [mem, cpu] = await Promise.all([readMeminfo(props), readCpuStat(props)]);
    const cores =
        typeof os.availableParallelism === 'function'
            ? os.availableParallelism()
            : Array.isArray(os.cpus()) && os.cpus().length
              ? os.cpus().length
              : 1;
    const machine = {
        ramTotalBytes: mem.ramTotalBytes,
        ramAvailableBytes: mem.ramAvailableBytes,
        cpuCores: cores,
    };
    // Первый тик не имеет предыдущего /proc/stat: cpuUtilization отсутствует (не 0 — «нет данных»).
    if (previousCpu && cpu.total > previousCpu.total) {
        const deltaTotal = cpu.total - previousCpu.total;
        const deltaIdle = Math.max(0, cpu.idles - previousCpu.idles);
        machine.cpuUtilization = Math.max(0, Math.min(1, 1 - deltaIdle / deltaTotal));
    }
    previousCpu = cpu;
    return machine;
}

/** Пути определены production-топологией, а не пользовательскими или произвольными env-путями. */
async function collectCapacity({ root = '/volumes', now = Date.now } = {}) {
    const result = { schemaVersion: 2, observedAt: now(), resources: {} };
    for (const resource of resources) {
        try {
            const base = path.join(root, resource === 'wal' ? 'postgres' : resource);
            const directory = resource === 'wal' ? path.join(base, 'pg_wal') : base;
            const actual = await fs.realpath(directory);
            const realBase = await fs.realpath(base);
            if (actual !== realBase && !actual.startsWith(realBase + path.sep)) {
                throw new Error('unmounted WAL');
            }
            const [disk, info] = await Promise.all([fs.statfs(actual, { bigint: true }), fs.stat(actual)]);
            if (!info.isDirectory()) {
                throw new Error('not directory');
            }
            const item = {
                available: true,
                filesystem: String(info.dev),
                totalBytes: safeNumber(disk.blocks * disk.bsize),
                freeBytes: safeNumber(disk.bavail * disk.bsize),
            };
            if (resource === 'wal') {
                let bytes = 0;
                for (const entry of await fs.readdir(actual, { withFileTypes: true })) {
                    if (!/^[0-9A-F]{24}(?:\.partial)?$/.test(entry.name)) {
                        continue;
                    }
                    const file = await fs.lstat(path.join(actual, entry.name));
                    if (!file.isFile() || file.isSymbolicLink()) {
                        throw new Error('WAL type');
                    }
                    bytes += file.size;
                    if (!Number.isSafeInteger(bytes)) {
                        throw new Error('WAL size');
                    }
                }
                item.walBytes = bytes;
            }
            result.resources[resource] = item;
        } catch (error) {
            // Несмонтированный том model-weights — явная ошибка, а не тихий «пустой» ресурс:
            // снапшот не публикуется, потребители получают CAPACITY_UNAVAILABLE (fail-fast).
            if (resource === 'model-weights' && error?.code === 'ENOENT') {
                throw new Error('Том model-weights не смонтирован у сборщика capacity.');
            }
            result.resources[resource] = { available: false };
        }
    }
    result.machine = await collectMachine();
    return result;
}
async function publishCapacity(value) {
    const temporary = destination + '.' + process.pid + '.partial';
    const dir = path.dirname(destination);
    await fs.mkdir(dir, { recursive: true });
    // D10/тикет 26: потребители (catalog/skills/rag-sync, uid 1000) маунтят /capacity:ro —
    // каталог должен быть r-x, файл r (снапшот = цифры ёмкости, не секретный материал).
    // chmod, а не mode в mkdir: при recursive mkdir mode не применяется к уже созданному
    // каталогу (например, 0700 от раннего запуска старого образа).
    await fs.chmod(dir, 0o755);
    try {
        await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o644, flush: true });
        await fs.rename(temporary, destination);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}
async function main() {
    if (process.argv.includes('--check')) {
        const value = JSON.parse(await fs.readFile(destination, 'utf8'));
        // Compat: во время rollout'а в общем томе может лежать legacy-снапшот (schemaVersion 1)
        // без model-weights — healthcheck не должен фэйлить на нём.
        const expected = value.schemaVersion === 1 ? resources.filter((key) => key !== 'model-weights') : resources;
        if (
            (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
            !Number.isSafeInteger(value.observedAt) ||
            Date.now() - value.observedAt > maxAgeMs ||
            expected.some((key) => !value.resources[key]?.available)
        ) {
            throw new Error('Сведения о физических томах недоступны.');
        }
        return;
    }
    if (process.argv.includes('--once')) {
        console.log(JSON.stringify(await collectCapacity()));
        return;
    }
    let stopping = false;
    let wake;
    const stop = () => {
        stopping = true;
        wake?.();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    while (!stopping) {
        try {
            await publishCapacity(await collectCapacity());
        } catch {
            console.error('Не удалось опубликовать сведения о физических томах.');
        }
        if (!stopping) {
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 15000);
                wake = () => {
                    clearTimeout(timer);
                    resolve();
                };
            });
        }
    }
}
module.exports = { collectCapacity, collectMachine, publishCapacity };
if (require.main === module) {
    void main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
