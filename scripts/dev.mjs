import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {nodeRuntime, npmCli} from './workspace/node-runtime.mjs';
import {ensureCompose,checkCompose} from './workspace/compose.mjs';
import {createDevOutput} from './workspace/dev-output.mjs';
import {devProcessIdentity, devServiceEntry, discoverDevProcesses, ownsDevProcess} from './workspace/dev-processes.mjs';
import {devServices,devServiceHealth,probeLocalEndpoint,serviceDetailsFlag} from './workspace/dev-service-health.mjs';
import {modelRuntimeEnvironment,startModelRuntime} from './models/startup.mjs';
import {prepareStartupAssets} from './assets/startup.mjs';
import {prepareDevModelCredentials} from './workspace/dev-model-credentials.mjs';
import {privateSnapshotFile} from './snapshots/control.mjs';
import {prepareDevSnapshots} from './workspace/dev-snapshots.mjs';
import {prepareDevChatStorage} from './workspace/dev-chat-storage.mjs';
import {withNpmBuildEnvironment} from './workspace/npm-build-environment.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const stateDir = path.join(root, '.run');
const stateFile = path.join(stateDir, 'processes.json');
const services = devServices;
const snapshotWorker={name:'snapshot-verifier',label:'Проверка снимков',dir:'.',port:4100,entry:'scripts/snapshots/runner.mjs'};
const managedServices=[...services,snapshotWorker];
const watchService={name:'source-watch',label:'Пересборка исходников',dir:'.',entry:'scripts/workspace/dev-watch-guardian.mjs'};
const trackedServices=[...managedServices,watchService];
const packages = [ ...services, {dir: 'mcp/neurocenter-asset-sync', label: 'Мост OpenCode'} ];
const defaultProfile = 'fast';
const output = createDevOutput({defaultProfile});
let node;
let logDir;

/** Показывает текущий этап без анимации, в том числе при перенаправлении в файл. */
function progress(total) {
    let index = 0;
    return label => output.step(++index, total, label);
}

/** Выполняет команду с передачей её ошибки вызывающему процессу. */
function run(command, args, cwd = root, env = process.env) {
    const gateway = path.resolve(cwd) === path.join(root, 'services/api-gateway');
    const childEnvironment = gateway ? {...env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NPM_CONFIG_STRICT_SSL: 'false'} : env;
    const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: childEnvironment });
    if (result.error) { throw result.error; }
    if (result.status !== 0) { throw new Error(`Команда ${path.basename(command)} ${args.join(' ')} ${result.signal ? `остановлена сигналом ${result.signal}` : `завершилась с кодом ${result.status}`}.`); }
}

/** Общий source contract устанавливается по HTTPS и integrity корневого lock-файла. */
async function installDependencies(cwd = root, extra = []) {
    const npm = npmCli(process.env);
    const gateway = path.resolve(cwd) === path.join(root, 'services/api-gateway');
    await withNpmBuildEnvironment(process.env, ({env, args}) => run(node, [npm, 'ci', ...extra, '--no-audit', '--no-fund', ...args.map(arg => gateway && arg === '--strict-ssl=true' ? '--strict-ssl=false' : arg)], cwd, env));
}
async function prepareWorkspaceDependencies() {
    await installDependencies(root, ['--ignore-scripts']);
}

/** Установка и сборка охватывают сервисы, интерфейс и мост. */
async function forPackages(command, next) {
    const npm = npmCli(process.env);
    for (const {dir, label} of packages) {
        next(`${command === 'install' ? 'Зависимости' : 'Сборка'} · ${label}`);
        const started = Date.now();
        const cwd = path.join(root, dir);
        if (command === 'install') { await installDependencies(cwd); }
        else {
            try { run(node, [ npm, 'run', 'build' ], cwd); }
            catch {
                // Повреждённый или неполный node_modules (прерванная установка, сбой диска) восстанавливаем
                // из lock-файла и повторяем сборку один раз; настоящая ошибка кода проявится повторно.
                output.warning(`Сборка «${label}» не прошла; восстанавливаем зависимости из lock-файла и повторяем.`);
                await installDependencies(cwd);
                run(node, [ npm, 'run', 'build' ], cwd);
            }
        }
        output.success(`${label} · ${((Date.now() - started) / 1000).toFixed(1)} с`);
    }

}

function entryFor(service) {
    return devServiceEntry(root, service);
}

function readProcesses() {
    try {
        const records = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (!Array.isArray(records) || records.some(record => !record || typeof record !== 'object'
            || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !trackedServices.some(service => service.name === record.name))) {
            throw new SyntaxError('Ожидается список PID сервисов');
        }
        return records;
    }
    catch (error) {
        if (error.code === 'ENOENT') { return []; }
        if (error instanceof SyntaxError) {
            output.warning('Список PID повреждён; ищем сервисы по их командам и рабочим каталогам.');
            return [];
        }
        throw error;
    }
}

/** Чужие процессы и переиспользованные PID не останавливаем, перенос checkout поддерживаем. */
function ownsProcess(record) {
    const service = trackedServices.find(item => item.name === record.name);
    return ownsDevProcess(record, root, service);
}

/** Факт завершения берём у запущенного ChildProcess, включая выход во время проверки HTTP. */
function assertServicesRunning(children) {
    const failed = children.find(({child}) => child.exitCode !== null || child.signalCode !== null);
    if (!failed) { return; }
    const {child, service, logFile} = failed;
    const reason = child.signalCode ? `сигнал ${child.signalCode}` : `код ${child.exitCode}`;
    throw new Error(`${service.label} (:${service.port}) завершился при запуске: ${reason}. Лог: ${logFile}`);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Процесс может успеть завершиться между проверкой принадлежности и сигналом. */
function signalProcess(pid, signal) {
    try { process.kill(pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') { throw error; } }
}

/** Останавливает только процессы, запущенные этим checkout; данные PostgreSQL сохраняются. */
async function stop(saved) {
    let known = saved ?? readProcesses();
    const watchers=[...known.filter(item=>item.name===watchService.name),...(!saved?discoverDevProcesses(root,[watchService],known.map(record=>record.pid)):[])].filter(ownsProcess);
    if(watchers.length){const {stopDevWatch}=await import('./workspace/dev-watch-control.mjs');for(const record of watchers)await stopDevWatch(root,record);if(!saved)known=readProcesses();}
    const discovered = saved ? [] : discoverDevProcesses(root, trackedServices, known.map(record => record.pid));
    const records = [...new Map([...known, ...discovered].map(record => [record.pid, record])).values()].filter(ownsProcess);
    for (const record of records) { signalProcess(record.pid, 'SIGTERM'); }
    const deadline = Date.now() + 5000;
    while (records.some(ownsProcess) && Date.now() < deadline) { await delay(100); }
    for (const record of records.filter(ownsProcess)) { signalProcess(record.pid, 'SIGKILL'); }
    const killedDeadline = Date.now() + 2000;
    while (records.some(ownsProcess) && Date.now() < killedDeadline) { await delay(50); }
    const remaining = records.filter(ownsProcess);
    if (remaining.length) { throw new Error(`Не удалось остановить сервисы (PID: ${remaining.map(record => record.pid).join(', ')}). Перезапуск отменён.`); }
    rmSync(stateFile, { force: true });
    return records.length;
}

/** Проверяем освобождение адресов до запуска новых процессов; чужие сервисы не останавливаем. */
async function assertServicePortsAvailable() {
    await Promise.all(services.map(service => new Promise((resolve, reject) => {
        const host = service.name === 'frontend' ? '127.0.0.1' : process.env.BIND_HOST || '127.0.0.1';
        const server = createServer();
        server.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
            ? `${service.label} (:${service.port}): порт ${host}:${service.port} занят другим процессом. Новые сервисы не запущены.`
            : `${service.label} (:${service.port}): не удалось проверить порт (${error.code || error.message}).`)));
        server.once('listening', () => server.close(error => error ? reject(error) : resolve()));
        server.listen({host, port: service.port, exclusive: true});
    })));
}

/** Liveness, passive dependency checks and OS ownership are separate evidence. */
async function health(deadline = Infinity, cancellation) {
    const read=devServiceHealth(services,{root,deadline,detailsEnabled:serviceDetailsFlag()});
    const readWorker=async()=>{
        try{
            const token=(await privateSnapshotFile(path.resolve(root,process.env.SNAPSHOT_VERIFIER_TOKEN_FILE||'.run/project-snapshots/secrets/verifier-token'),1024)).toString('utf8').trim();
            const probe=await probeLocalEndpoint({...snapshotWorker,path:'/internal/project-snapshots/verifier/ready'},
                {signal:cancellation,deadline,headers:{'x-neurocenter-snapshot-verifier':token}});
            return {...snapshotWorker,ok:probe.ok===true,available:probe.ok===true};
        }catch{return {...snapshotWorker,ok:false,available:false};}
    };
    const [probes,worker]=await Promise.all([read(cancellation),readWorker()]);
    const results=probes.map(result=>{
        const base=result.service==='frontend'?result.compilation:result.liveness;
        const available=base.ok===true&&(result.readiness.state==='skipped'||result.readiness.ok===true)&&result.ownership.state!=='foreign';
        return {...services.find(service=>service.name===result.service),...result,available,ok:result.ready===true&&result.ownership.state==='owned'};
    });
    results.push(worker);
    return results;
}

/** Show unknown checks explicitly so a healthy HTTP process cannot imply full readiness. */
function reportHealth(results){
    for(const service of results){
        if(!service.liveness){output.service(service);continue;}
        const live=service.name==='frontend'?`компиляция: ${service.compilation.ok===true?'готова (частичная проверка)':'не готова'}`
            :`процесс: ${service.liveness.ok===true?'отвечает':'не отвечает'}`;
        const ready=service.readiness.state==='skipped'
            ?`готовность: ${service.readiness.reason==='disabled'?'проверка отключена':service.readiness.reason==='side-effectful-endpoint'?'не проверена (проверка пишет файлы)':'не применима'}`
            :`зависимости: ${service.readiness.ok===true?'готовы':'не готовы'}`;
        const owner={owned:'этот',foreign:'другой',unknown:'неизвестен',disabled:'проверка отключена'}[service.ownership.state];
        output.info(`${service.label} (:${service.port})`,`${live}; ${ready}; checkout: ${owner}`);
    }
}

async function start(profile,watchMode=false) {
    const prepareAssets = profile !== 'fast' || process.stdin.isTTY === true && process.stdout.isTTY === true, prepareModels = profile === 'full';
    output.info('Профиль запуска', {fast:'fast — приложения; выбор ассетов в терминале, иначе сохранённый кэш',standard:'standard — мост и инструменты, без весов моделей',full:'full — мост, инструменты и все модели'}[profile]);
    const next = progress(packages.length + 8);
    next('Проверка Docker и Compose');
    checkCompose();
    output.success('Docker готов к запуску');
    next('Выбор и подготовка ассетов');
    await prepareWorkspaceDependencies();
    if (prepareAssets) { await prepareStartupAssets({root,output,environment:process.env,withoutModels:!prepareModels}); }
    else { output.info('Ассеты', 'Используются уже сохранённые файлы; загрузка поставки пропущена.'); }
    // Сборка до остановки предыдущего экземпляра: ошибка компиляции не прерывает его работу.
    await forPackages('build', next);
    next('Запуск PostgreSQL');
    run('docker', [ 'compose', 'up', '-d', '--wait', '--wait-timeout', '45', 'postgres' ]);
    const postgres = spawnSync('docker', ['compose', 'ps', '-q', 'postgres'], {cwd:root,encoding:'utf8'});
    if (postgres.status !== 0 || !postgres.stdout.trim()) { throw new Error('Не найден контейнер PostgreSQL'); }
    output.success('PostgreSQL готов');
    next('Запуск хостинга моделей');
    if (prepareModels) { await startModelRuntime({root,output,environment:process.env}); }
    else { output.info('Хостинг моделей', 'Подготовка весов и запуск runtime пропущены выбранным профилем.'); }
    next('Каталог инструментов');
    output.info('Состав каталога', 'Выбирается главным администратором на странице «Ассеты». Запуск сохраняет текущие карточки.');
    const modelCredentials=await prepareDevModelCredentials(root,process.env);
    output.info('Снимки LanceDB','Проверка ключа и изолированного SDK-исполнителя');
    const snapshots=await prepareDevSnapshots(root,process.env);
    output.info('Файлы чата', 'Подготовка приватного S3-хранилища');
    const chatStorage=await prepareDevChatStorage(root,process.env,{output});
    const runtimeEnvironment=modelRuntimeEnvironment(root,process.env);
    next('Остановка прежних локальных процессов');
    await stop();
    await assertServicePortsAvailable();
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    const commonEnvironment={...process.env};
    for(const key of Object.keys(commonEnvironment))if(key.startsWith('SNAPSHOT_'))delete commonEnvironment[key];
    for(const key of Object.keys(commonEnvironment))if(key.startsWith('CHAT_S3_'))delete commonEnvironment[key];
    delete commonEnvironment.NEUROCENTER_MODEL_CREDENTIAL_KEY;delete commonEnvironment.NEUROCENTER_MODEL_CREDENTIAL_KEY_FILE;
    const shared = {
        ...commonEnvironment,
        ...runtimeEnvironment,
        DEV_POSTGRES_CONTAINER: postgres.stdout.trim(),
        BACKUP_DIR: path.resolve(root, process.env.BACKUP_DIR || 'data/backups'),
        RUNTIME_ARTIFACT_DIR:path.resolve(root,process.env.RUNTIME_ARTIFACT_DIR||'data/runtime-artifacts'),
        CATALOG_SERVICE_URL: 'http://127.0.0.1:4100',
        SKILLS_SERVICE_URL: 'http://127.0.0.1:4200',
        RAG_SERVICE_URL: 'http://127.0.0.1:4300',
        FEATURE_FLAGS_SERVICE_URL: 'http://127.0.0.1:4400',
        AUTH_SERVICE_URL: 'http://127.0.0.1:22222',
        CATALOG_PG_URL: process.env.CATALOG_PG_URL_FILE?undefined:process.env.CATALOG_PG_URL || 'postgresql://rag:rag@localhost:5432/catalog',
        ...(process.env.CATALOG_PG_URL_FILE?{CATALOG_PG_URL_FILE:path.resolve(root,process.env.CATALOG_PG_URL_FILE)}:{}),
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
    const children = [];
    // Detached-сервисы не получают Ctrl+C терминала; отмена очищает только новый запуск.
    const cancellation = new AbortController();
    const cancel = signal => cancellation.abort(Object.assign(new Error('Запуск сервисов прерван; процессы нового запуска остановлены.'), {code: 'ECANCELED', signal}));
    const interrupt = () => cancel('SIGINT'), terminate = () => cancel('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
        next('Запуск сервисов');
        const environmentFor=service=>service.name==='snapshot-verifier'?snapshots.runner:{ ...shared, ...(service.name==='catalog'?{...modelCredentials,...snapshots.catalog,...chatStorage}:{}),
            ...(service.name==='gateway'?{NODE_ENV:'development', DEV_BRIDGE_RUNTIME_DIR:path.join(root, '.run/dev-bridge/runtime')}:{}), PORT:String(service.port)};
        if(watchMode){
            const {startDevWatch}=await import('./workspace/dev-watch-control.mjs');
            const watcher=await startDevWatch({root,node,logDir,signal:cancellation.signal,services:managedServices.map(service=>({...service,entry:entryFor(service),environment:environmentFor(service)}))});
            records.push(watcher.record);children.push({child:watcher.child,service:watchService,logFile:path.join(logDir,'neurocenter-source-watch.log')});
        }else for (const service of managedServices) {
            cancellation.signal.throwIfAborted();
            const logFile = path.join(logDir, `neurocenter-${service.name}.log`);
            const log = openSync(logFile, 'a');
            const child = spawn(node, [ entryFor(service) ], {
                cwd: path.join(root, service.dir),
                env: environmentFor(service),
                detached: true,
                stdio: [ 'ignore', log, log ],
            });
            children.push({child, service, logFile});
            try {
                await new Promise((resolve, reject) => {
                    child.once('spawn', resolve);
                    child.once('error', reject);
                });
            } catch (error) {
                throw new Error(`${service.label} (:${service.port}) не запущен: ${error.message}. Лог: ${logFile}`);
            } finally { closeSync(log); }
            child.unref();
            records.push({ name: service.name, pid: child.pid, identity: devProcessIdentity(child.pid) });
            writeFileSync(stateFile, JSON.stringify(records, null, 2));
        }

        next('Проверка готовности — до 45 секунд');
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
            cancellation.signal.throwIfAborted();
            assertServicesRunning(children);
            const results = await health(deadline, cancellation.signal);
            cancellation.signal.throwIfAborted();
            assertServicesRunning(children);
            if (results.every(service => service.available)) {
                reportHealth(results);
                try {
                    const {applyPublishedDevBridge} = await import('./workspace/dev-bridge-startup.mjs');
                    await applyPublishedDevBridge({root, node, environment: process.env, output});
                } catch (error) { output.warning('Обновление установленного моста отложено: '+error.message+' Сервисы продолжают работать; повторите scripts/dev.sh up.'); }
                cancellation.signal.throwIfAborted();
                assertServicesRunning(children);
                const fullyReady=results.every(service=>service.ok);
                output.heading(fullyReady?'Готов к работе':'Сервисы запущены');
                if(!fullyReady)output.warning('Полная готовность не подтверждена: выше перечислены пропущенные проверки и неизвестная принадлежность процессов.');
                output.info('Интерфейс', 'http://localhost:5173');
                output.info('Логи', logDir);
                output.info('Проверить состояние', 'scripts/dev.sh status');
                output.info('Остановить', 'scripts/dev.sh down');
                if(watchMode)output.info('Watch','Включён: изменения сервисов/shared собираются последовательно; статус — scripts/dev.sh status.');
                return;
            }
            await delay(500);
        }
        throw new Error(`Сервисы не готовы за 45 секунд. Логи: ${logDir}`);
    } catch (error) {
        await stop(records);
        throw error;
    } finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
    }
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const commands = ['install', 'build', 'check', 'up', 'watch', 'down', 'status', 'tail'];
    const helpFlags = ['--help', '-h', '—help'];
    // Scoped checks admit arguments before dotenv and keep their own report and exit status.
    if (command === 'check') {
        const {parseCheckOptions, checkPlan, checkHelp} = await import('./workspace/check-plan.mjs');
        const options = parseCheckOptions(args.slice(1));
        if (options.help) { console.log(checkHelp); return; }
        checkPlan(root, options);
        const {launchNode24} = await import('./workspace/node24-cli.mjs');
        await launchNode24(path.join(root, 'scripts/workspace/check.mjs'), args.slice(1));
        return;
    }
    if (!args.length || args.length === 1 && (command === 'help' || helpFlags.includes(command))
        || args.length === 2 && commands.includes(command) && helpFlags.includes(args[1])) {
        output.help();
        return;
    }
    let profile = defaultProfile;
    let seenProfile = false;
    let watchMode=command==='watch',seenWatch=false;
    let invalid = !commands.includes(command);
    for (let index = 1; index < args.length && !invalid; index++) {
        const argument = args[index];
        if((command==='up'||command==='watch')&&argument==='--watch'&&!seenWatch){watchMode=true;seenWatch=true;continue;}
        if (!['up','watch'].includes(command) || seenProfile || !(argument === '--profile' || argument.startsWith('--profile='))) { invalid = true; break; }
        profile = argument === '--profile' ? args[++index] : argument.slice('--profile='.length);
        seenProfile = true;
        if (!['fast','standard','full'].includes(profile)) { invalid = true; }
    }
    if (invalid) {
        output.error(`Неизвестная команда или параметры: ${args.join(' ')}`);
        output.help();
        process.exitCode = 1;
        return;
    }
    if (Number(process.versions.node.split('.')[0]) !== 24) {
        const runtime = nodeRuntime();
        const result = spawnSync(runtime.node, [fileURLToPath(import.meta.url), ...args], {stdio:'inherit',env:runtime.env});
        if (result.error) { throw result.error; }
        process.exitCode = result.status ?? 1;
        return;
    }
    // Переменные процесса имеют приоритет; затем локальные настройки машины и общий .env.
    for (const name of [ '.env.local', '.env' ]) {
        try { process.loadEnvFile(path.join(root, name)); }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    if(command==='up'||command==='status')serviceDetailsFlag();
    const runtime = nodeRuntime();
    node = runtime.node;
    process.env.PATH = runtime.env.PATH;
    process.env.NODE_BIN = node;
    logDir = process.env.LOGDIR || path.join(stateDir, 'logs');

    const titles = {install:'Установка зависимостей и обновление моста',build:'Сборка проекта',check:'Проверка проекта',up:'Запуск проекта',watch:'Запуск с пересборкой исходников',down:'Остановка проекта',status:'Состояние сервисов',tail:'Последние 20 строк логов'};
    output.heading(titles[command]);
    if (command === 'install') {
        const next = progress(packages.length + 3);
        next('Проверка и подготовка Docker Compose');
        await ensureCompose();
        next('Установка общего контракта ассетов');
        await prepareWorkspaceDependencies();
        await forPackages(command, next);
        next('Подготовка dev-поставки моста');
        const {prepareDevBridge} = await import('./workspace/dev-bridge-runtime.mjs');
        await prepareDevBridge({root, node, environment: process.env, output});
        output.success('Зависимости установлены');
        output.info('Запустить проект', 'scripts/dev.sh up');
    }
    else if (command === 'build') {
        const next = progress(packages.length + 1);
        next('Установка общего контракта ассетов'); await prepareWorkspaceDependencies();
        await forPackages(command, next); output.success('Проект собран');
    }
    else if (command === 'up'||command==='watch') { await start(profile,watchMode); }
    else if (command === 'down') {
        const count = await stop();
        if (count) { output.success(`Остановлено процессов этого каталога: ${count}`); }
        else { output.info('Локальные процессы', 'Активных процессов этого каталога не найдено'); }
        output.info('Данные', 'PostgreSQL и рабочие файлы сохранены');
        output.info('Запустить снова', 'scripts/dev.sh up');
    }
    else if (command === 'status') {
        const results = await health();
        if(existsSync(path.join(stateDir,'dev-watch/status.json'))){const {devWatchStatus}=await import('./workspace/dev-watch-control.mjs');const watch=await devWatchStatus(root);if(watch){output.info('Watch',watch.alive?watch.phase:'остановлен');if(watch.lastBuild?.ok===false)output.warning('Последняя пересборка не применена: '+watch.lastBuild.code+'; предыдущие сервисы сохранены. Лог: '+path.join(stateDir,'dev-watch/last-failure'));}}
        reportHealth(results);
        const ready = results.filter(service => service.ok).length;
        if (ready === results.length) { output.success(`Все сервисы готовы: ${ready}/${results.length}`); output.info('Интерфейс', 'http://localhost:5173'); }
        else {
            output.warning(`Подтверждена готовность сервисов: ${ready}/${results.length}; остальные проверки не пройдены или пропущены. Запуск: scripts/dev.sh up`);
            if(results.some(service=>!service.available))process.exitCode=1;
        }
        output.info('Логи', logDir);
    } else if (command === 'tail') {
        let found = 0;
        for (const service of managedServices) {
            const file = path.join(logDir, `neurocenter-${service.name}.log`);
            if (existsSync(file)) { found++; output.logs(service.label, readFileSync(file, 'utf8').trimEnd().split('\n').slice(-20).join('\n')); }
        }
        if (!found) { output.info('Логи', 'Пока нет — появятся после первого запуска проекта.'); }
        output.info('Каталог логов', logDir);
    }
}

main().catch(error => {
    output.error(error.message);
    process.exitCode = error.code === 'ECANCELED' ? (error.signal === 'SIGTERM' ? 143 : 130) : 1;
});
