import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {nodeRuntime, npmCli} from './workspace/node-runtime.mjs';
import {ensureCompose,checkCompose} from './workspace/compose.mjs';
import {createDevOutput} from './workspace/dev-output.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = path.join(root, '.run');
const stateFile = path.join(stateDir, 'processes.json');
const services = [
    { name: 'bridge', label: 'Вход и сессии', dir: 'services/oauth2-bridge', port: 22222 },
    { name: 'catalog', label: 'Каталог', dir: 'services/catalog-service', port: 4100 },
    { name: 'skills', label: 'Скиллы', dir: 'services/skills-service', port: 4200 },
    { name: 'rag', label: 'Базы знаний', dir: 'services/rag-sync-service', port: 4300 },
    { name: 'gateway', label: 'API', dir: 'services/api-gateway', port: 4000 },
    { name: 'frontend', label: 'Веб-интерфейс', dir: 'frontend', port: 5173 },
];
const packages = [ ...services, {dir: 'mcp/neurocenter-asset-sync', label: 'Мост OpenCode'} ];
const output = createDevOutput();
let node;
let logDir;

/** Показывает текущий этап без анимации, в том числе при перенаправлении в файл. */
function progress(total) {
    let index = 0;
    return label => output.step(++index, total, label);
}

/** Выполняет команду с передачей её ошибки вызывающему процессу. */
function run(command, args, cwd = root) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
    if (result.error) { throw result.error; }
    if (result.status !== 0) { throw new Error(`Команда ${path.basename(command)} ${args.join(' ')} ${result.signal ? `остановлена сигналом ${result.signal}` : `завершилась с кодом ${result.status}`}.`); }
}

/** Установка и сборка охватывают сервисы, интерфейс и мост. */
function forPackages(command, next) {
    const npm = npmCli(process.env);
    for (const {dir, label} of packages) {
        next(`${command === 'install' ? 'Зависимости' : 'Сборка'} · ${label}`);
        const started = Date.now();
        const cwd = path.join(root, dir);
        if (command === 'install') { run(node, [ npm, 'ci', '--no-audit', '--no-fund' ], cwd); }
        else { run(node, [ npm, 'run', 'build' ], cwd); }
        output.success(`${label} · ${((Date.now() - started) / 1000).toFixed(1)} с`);
    }
    if (command === 'build') {
        next('Подготовка переносимого пакета моста');
        run('bash', [ path.join(root, 'scripts/package-bridge.sh') ]);
        output.success('Пакет моста подготовлен');
    }
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
    return records.length;
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
    const next = progress(packages.length + 6);
    next('Проверка Docker и Compose');
    checkCompose();
    output.success('Docker готов к запуску');
    // Сборка до остановки предыдущего экземпляра: ошибка компиляции не прерывает его работу.
    forPackages('build', next);
    next('Запуск PostgreSQL');
    run('docker', [ 'compose', 'up', '-d', '--wait', '--wait-timeout', '45', 'postgres' ]);
    const postgres = spawnSync('docker', ['compose', 'ps', '-q', 'postgres'], {cwd:root,encoding:'utf8'});
    if (postgres.status !== 0 || !postgres.stdout.trim()) { throw new Error('Не найден контейнер PostgreSQL'); }
    output.success('PostgreSQL готов');
    next('Остановка прежних локальных процессов');
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
        next('Запуск сервисов');
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

        next('Проверка готовности — до 45 секунд');
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            if (records.some(record => !ownsProcess(record))) { throw new Error(`Сервис завершился при запуске. Логи: ${logDir}`); }
            const results = await health();
            if (results.every(service => service.ok)) {
                for (const service of results) { output.service(service); }
                output.heading('Готов к работе');
                output.info('Интерфейс', 'http://localhost:5173');
                output.info('Логи', logDir);
                output.info('Проверить состояние', 'scripts/dev.sh status');
                output.info('Остановить', 'scripts/dev.sh down');
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
    const args = process.argv.slice(2);
    const command = args[0];
    const commands = ['install', 'build', 'check', 'up', 'down', 'status', 'tail'];
    if (!args.length || args.length === 1 && ['--help', '-h', 'help'].includes(command)
        || args.length === 2 && commands.includes(command) && ['--help', '-h'].includes(args[1])) {
        output.help();
        return;
    }
    if (args.length !== 1 || !commands.includes(command)) {
        output.error(`Неизвестная команда или параметры: ${args.join(' ')}`);
        output.help();
        process.exitCode = 1;
        return;
    }
    if (Number(process.versions.node.split('.')[0]) < 24) {
        const runtime = nodeRuntime();
        const result = spawnSync(runtime.node, [fileURLToPath(import.meta.url), ...args], {stdio:'inherit',env:process.env});
        if (result.error) { throw result.error; }
        process.exitCode = result.status ?? 1;
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

    const titles = {install:'Установка зависимостей',build:'Сборка проекта',check:'Проверка проекта',up:'Запуск проекта',down:'Остановка проекта',status:'Состояние сервисов',tail:'Последние 20 строк логов'};
    output.heading(titles[command]);
    if (command === 'check') { run(node, [ path.join(root, 'scripts/workspace/check.mjs') ]); output.success('Проверки проекта завершены'); }
    else if (command === 'install') {
        const next = progress(packages.length + 1);
        next('Проверка и подготовка Docker Compose');
        await ensureCompose();
        forPackages(command, next);
        output.success('Зависимости установлены');
        output.info('Запустить проект', 'scripts/dev.sh up');
    }
    else if (command === 'build') { forPackages(command, progress(packages.length + 1)); output.success('Проект собран'); }
    else if (command === 'up') { await start(); }
    else if (command === 'down') {
        const count = await stop();
        if (count) { output.success(`Остановлено процессов этого каталога: ${count}`); }
        else { output.info('Локальные процессы', 'Активных процессов этого каталога не найдено'); }
        output.info('Данные', 'PostgreSQL и рабочие файлы сохранены');
        output.info('Запустить снова', 'scripts/dev.sh up');
    }
    else if (command === 'status') {
        const results = await health();
        for (const service of results) { output.service(service); }
        const ready = results.filter(service => service.ok).length;
        if (ready === results.length) { output.success(`Все сервисы готовы: ${ready}/${results.length}`); output.info('Интерфейс', 'http://localhost:5173'); }
        else { output.warning(`Готово сервисов: ${ready}/${results.length}. Запуск: scripts/dev.sh up`); process.exitCode = 1; }
        output.info('Логи', logDir);
    } else if (command === 'tail') {
        let found = 0;
        for (const service of services) {
            const file = path.join(logDir, `neurocenter-${service.name}.log`);
            if (existsSync(file)) { found++; output.logs(service.label, readFileSync(file, 'utf8').trimEnd().split('\n').slice(-20).join('\n')); }
        }
        if (!found) { output.info('Логи', 'Пока нет — появятся после первого запуска проекта.'); }
        output.info('Каталог логов', logDir);
    }
}

main().catch(error => { output.error(error.message); process.exitCode = 1; });
