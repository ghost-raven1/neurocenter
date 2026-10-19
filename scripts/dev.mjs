import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {nodeRuntime, npmCli} from './workspace/node-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = path.join(root, '.run');
const stateFile = path.join(stateDir, 'processes.json');
const services = [
    { name: 'bridge', dir: 'services/oauth2-bridge', port: 22222 },
    { name: 'catalog', dir: 'services/catalog-service', port: 4100 },
    { name: 'skills', dir: 'services/skills-service', port: 4200 },
    { name: 'rag', dir: 'services/rag-sync-service', port: 4300 },
    { name: 'gateway', dir: 'services/api-gateway', port: 4000 },
    { name: 'frontend', dir: 'frontend', port: 5173 },
];
const packages = [ ...services.map(service => service.dir), 'mcp/neurocenter-asset-sync' ];
let node;
let logDir;

/** Выполняет команду с передачей её ошибки вызывающему процессу. */
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
    if (result.error) { throw result.error; }
    if (result.status !== 0) { throw new Error(`Команда ${command} ${args.join(' ')} завершилась с кодом ${result.status}`); }
}

/** Установка и сборка охватывают сервисы, интерфейс и мост. */
function forPackages(command) {
    const npm = npmCli(process.env);
    for (const dir of packages) {
        console.log(`\n${dir}: ${command}`);
        const cwd = path.join(root, dir);
        if (command === 'install') { run(node, [ npm, 'ci', '--no-audit', '--no-fund' ], cwd); }
        else { run(node, [ npm, 'run', 'build' ], cwd); }
    }
    if (command === 'build') { run('bash', [ path.join(root, 'scripts/package-bridge.sh') ]); }
}

function entryFor(service) {
    return path.join(root, service.dir, service.name === 'frontend' ? 'node_modules/vite/bin/vite.js' : 'dist/main.js');
}

function readProcesses() {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') { return []; }
        throw error;
    }
}

/** Проверяем PID и команду: чужие процессы и переиспользованные PID не останавливаем. */
function ownsProcess(record) {
    const service = services.find(item => item.name === record.name);
    if (!service || !Number.isSafeInteger(record.pid) || record.pid <= 0) { return false; }
    const result = spawnSync('ps', [ '-p', String(record.pid), '-o', 'command=' ], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.includes(entryFor(service));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Останавливает только процессы, запущенные этим checkout; данные PostgreSQL сохраняются. */
async function stop() {
    const records = readProcesses().filter(ownsProcess);
    for (const record of records) { process.kill(record.pid, 'SIGTERM'); }
    const deadline = Date.now() + 5000;
    while (records.some(ownsProcess) && Date.now() < deadline) { await delay(100); }
    for (const record of records.filter(ownsProcess)) { process.kill(record.pid, 'SIGKILL'); }
    rmSync(stateFile, { force: true });
}

/** Один снимок готовности: HTTP и JSON health проверяются отдельно для каждого сервиса. */
async function health() {
    return Promise.all(services.map(async service => {
        const suffix = service.name === 'frontend' ? '/' : '/health';
        try {
            const response = await fetch(`http://127.0.0.1:${service.port}${suffix}`, { signal: AbortSignal.timeout(1000) });
            const ok = response.ok && (service.name === 'frontend' || (await response.json()).ok === true);
            return { ...service, ok };
        } catch { return { ...service, ok: false }; }
    }));
}

async function start() {
    // Сборка до остановки предыдущего экземпляра: ошибка компиляции не прерывает его работу.
    forPackages('build');
    run('docker', [ 'compose', 'up', '-d', '--wait', '--wait-timeout', '45', 'postgres' ]);
    const postgres = spawnSync('docker', ['compose', 'ps', '-q', 'postgres'], {cwd:root,encoding:'utf8'});
    if (postgres.status !== 0 || !postgres.stdout.trim()) { throw new Error('Не найден контейнер PostgreSQL'); }
    await stop();
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    const shared = {
        ...process.env,
        DEV_POSTGRES_CONTAINER: postgres.stdout.trim(),
        BACKUP_DIR: path.resolve(root, process.env.BACKUP_DIR || 'data/backups'),
        RUNTIME_ARTIFACT_DIR:path.resolve(root,process.env.RUNTIME_ARTIFACT_DIR||'data/runtime-artifacts'),
        CATALOG_SERVICE_URL: 'http://127.0.0.1:4100',
        SKILLS_SERVICE_URL: 'http://127.0.0.1:4200',
        RAG_SERVICE_URL: 'http://127.0.0.1:4300',
        AUTH_SERVICE_URL: 'http://127.0.0.1:22222',
        CATALOG_PG_URL: process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
        RAG_PG_URL: process.env.RAG_PG_URL || 'postgresql://rag:rag@localhost:5432/rag',
        PROJECTS_ROOT: path.resolve(root, process.env.PROJECTS_ROOT || path.join(homedir(), 'projects')),
        SKILLS_STORAGE_PATH: path.resolve(root, process.env.SKILLS_STORAGE_PATH || 'data/skills'),
        // Dev всегда запускает мост текущего checkout, а не путь из чужого контейнера.
        ASSET_SYNC_NODE_BIN: node,
        ASSET_SYNC_MCP_BIN: path.join(root, 'mcp/neurocenter-asset-sync/dist/index.js'),
        SSO_DISABLE: process.env.SSO_DISABLE || 'true',
        RAG_AUTH_DISABLED: 'false',
        AUTH_GUARD_ENABLED: 'true',
    };
    const records = [];
    try {
        for (const service of services) {
            const log = openSync(path.join(logDir, `neurocenter-${service.name}.log`), 'a');
            const child = spawn(node, [ entryFor(service) ], {
                cwd: path.join(root, service.dir),
                env: { ...shared, PORT: String(service.port) },
                detached: true,
                stdio: [ 'ignore', log, log ],
            });
            try {
                await new Promise((resolve, reject) => {
                    child.once('spawn', resolve);
                    child.once('error', reject);
                });
            } finally { closeSync(log); }
            child.unref();
            records.push({ name: service.name, pid: child.pid });
            writeFileSync(stateFile, JSON.stringify(records, null, 2));
        }

        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (records.some(record => !ownsProcess(record))) { throw new Error(`Сервис завершился при запуске. Логи: ${logDir}`); }
            if ((await health()).every(service => service.ok)) {
                console.log(`\nНейроцентр готов: http://localhost:5173\nЛоги: ${logDir}`);
                return;
            }
            await delay(500);
        }
        throw new Error(`Сервисы не готовы за 45 секунд. Логи: ${logDir}`);
    } catch (error) {
        await stop();
        throw error;
    }
}

async function main() {
    if (Number(process.versions.node.split('.')[0]) < 24) {
        const runtime = nodeRuntime();
        run(runtime.node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)]);
        return;
    }
    // Переменные процесса имеют приоритет; затем локальные настройки машины и общий .env.
    for (const name of [ '.env.local', '.env' ]) {
        try { process.loadEnvFile(path.join(root, name)); }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    const runtime = nodeRuntime();
    node = runtime.node;
    process.env.PATH = runtime.env.PATH;
    process.env.NODE_BIN = node;
    logDir = process.env.LOGDIR || path.join(stateDir, 'logs');

    const command = process.argv[2];
    if (command === 'check') { run(node, [ path.join(root, 'scripts/workspace/check.mjs') ]); }
    else if ([ 'install', 'build' ].includes(command)) { forPackages(command); }
    else if (command === 'up') { await start(); }
    else if (command === 'down') { await stop(); console.log('Сервисы остановлены.'); }
    else if (command === 'status') {
        const results = await health();
        for (const service of results) { console.log(`${service.name.padEnd(9)} :${service.port} — ${service.ok ? 'готов' : 'недоступен'}`); }
        if (results.some(service => !service.ok)) { process.exitCode = 1; }
    } else if (command === 'tail') {
        for (const service of services) {
            const file = path.join(logDir, `neurocenter-${service.name}.log`);
            if (existsSync(file)) { console.log(`${service.name}\n${readFileSync(file, 'utf8').split('\n').slice(-20).join('\n')}`); }
        }
    } else {
        console.log('Использование: scripts/dev.sh install | build | check | up | down | status | tail');
        if (command) { process.exitCode = 1; }
    }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
