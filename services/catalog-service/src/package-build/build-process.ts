import {stageUploadSource} from '../source-upload/stage-upload';
import {createHash} from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BuildConfiguration } from './package-build.model';
import {hasBuildReapProof} from './build-cleanup';

export const builderScript = (): string => path.resolve(process.env.TOOL_BUILD_SCRIPT || path.join(__dirname, '../../../../scripts/catalog-plugins/build.mjs'));
export const stagingLimit = 4 * 1024 ** 3;
interface BuildProgress {type: 'build-progress'; target: string; completed: number; total: number}
const buildFailures: Record<string, string> = {
    SOURCE_RESOURCE_UNSUPPORTED: 'Исходники читают соседний runtime-ресурс, который не переносится при сборке JS/TS. Выберите готовый JavaScript npm-пакет; готовый MCP также можно добавить runtime-архивом с ресурсами.',
    PYTHON_DEPENDENCIES_UNAVAILABLE: 'Не удалось подготовить зависимости Python для выбранной платформы. Проверьте requirements.txt или pyproject.toml: для зависимостей нужны совместимые готовые wheel-пакеты из PyPI и доступ к PyPI.',
    PYTHON_RUNTIME_UNAVAILABLE: 'Не удалось подготовить встроенный Python. Проверьте доступ к источнику runtime и повторите сборку. Поставка с непроверенным или отсутствующим интерпретатором не опубликована.',
    PYTHON_SOURCE_INVALID: 'Не удалось проверить исходники Python. Проверьте файл запуска и статические зависимости в pyproject.toml или requirements.txt, затем заново выберите источник.',
};
export class BuildProcessUnreapedError extends Error{constructor(){super('Остановка дочернего сборщика ещё не подтверждена. Временные файлы сохранены. Можно продолжить работу с другими сборками.');}}

/** Лимит включает npm-cache, промежуточные файлы и готовые архивы одного задания. */
export async function stagingBytes(root: string): Promise<number> {
    root = await fs.realpath(root);
    let bytes = 0, count = 0;
    const producer = path.join(root, 'output', '.source-cache', 'python-producer');
    const insideProducer = (filename: string): boolean => {
        const relative = path.relative(producer, filename);
        return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    const walk = async (directory: string): Promise<void> => {
        let entries;
        try { entries = await fs.readdir(directory, {withFileTypes: true}); }
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return;} throw error;}
        for (const entry of entries) {
            const filename = path.join(directory, entry.name);
            let info;
            try { info = await fs.lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
            if (info.isSymbolicLink()) {
                // UV's private wheel cache uses links. It stays inside this job, is counted, and is never packed.
                if (!insideProducer(filename)) { throw new Error('Сборка создала ссылку или специальный файл.'); }
                let target: string;
                try { target = path.resolve(path.dirname(filename), await fs.readlink(filename)); }
                catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
                if (!insideProducer(target)) { throw new Error('Кэш Python выходит за приватную папку сборщика.'); }
                try { if (!insideProducer(await fs.realpath(filename))) { throw new Error('Кэш Python выходит за приватную папку сборщика.'); } }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            } else if (!info.isDirectory() && !info.isFile()) { throw new Error('Сборка создала ссылку или специальный файл.'); }
            if (++count > 100_000) { throw new Error('Сборка превысила лимит числа файлов.'); }
            bytes += info.isFile() || info.isSymbolicLink() ? info.size : 0;
            if (bytes > stagingLimit) { throw new Error('Сборка превысила лимит staging 4 ГиБ.'); }
            if (info.isDirectory()) { await walk(filename); }
        }
    };
    await walk(root);
    return bytes;
}

export function stopBuildProcess(child: ChildProcess): void {
    if(supervised.has(child)){
        if(typeof child.exitCode==='number'||typeof child.signalCode==='string')return;
        if(child.connected){child.send({type:'cancel'},error=>{if(error)child.kill('SIGTERM');});}else child.kill('SIGTERM');
        return;
    }
    try { if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, 'SIGKILL'); } else { child.kill('SIGKILL'); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { throw error; } }
}
const supervised=new WeakSet<ChildProcess>();

/** Исполняется только наш builder; исходники задают декларацию, а не shell-команду. */
export async function runPackageBuilder(config: BuildConfiguration, stage: string, observe: (child: ChildProcess | undefined) => void,
    onProgress?: (event: BuildProgress) => Promise<void>,signal?:AbortSignal,execution?:{nonce:string;markStarted:()=>Promise<void>;reaped?:()=>void}): Promise<string> {
    signal?.throwIfAborted();
    const source = path.join(stage, 'source');
    await fs.mkdir(source, {mode: 0o700});
    const identity=config.source.type==='upload'?{...config,source:{...config.source,uploadId:undefined}}:config;
    const key = 'tool-' + createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32);
    let recipeSource: Record<string, unknown>;
    if(config.source.type==='upload'){recipeSource=await stageUploadSource(config.source,stage);}
    else if (config.source.type === 'npm') {
        const adapter = config.source.package === 'opencode-rag-plugin' ? 'opencode-rag' : config.source.package === 'opencode-snip' ? 'opencode-snip' : undefined;
        recipeSource = adapter ? {type: 'prepared', adapter} : {type: 'npm', package: config.source.package, version: config.source.version, entrypoint: config.source.entrypoint};
    }
    else if (config.source.type === 'repository') {recipeSource = {...config.source};}
    else {
        for (const file of config.source.files) {
            const target = path.join(source, file.path);
            await fs.mkdir(path.dirname(target), {recursive: true, mode: 0o700});
            await fs.writeFile(target, file.content, {flag: 'wx', mode: 0o600});
        }
        recipeSource = {type: 'project', directory: 'source', entrypoint: config.source.entrypoint};
    }
    const recipe = {schemaVersion: 1, key, name: config.name, kind: config.kind, description: config.description,
        revision: config.source.type==='upload'?'source-'+config.source.sha256:config.source.type === 'npm' ? config.source.version : config.source.type === 'repository' ? 'git-' + config.source.commit : 'source-' + createHash('sha256').update(JSON.stringify(config.source)).digest('hex'), tags: config.tags, source: recipeSource,
        config: config.kind === 'mcp' ? {transport: 'stdio', args: config.source.type === 'files' ? config.source.args ?? [] : []} : {}, targets: config.targets};
    const recipePath = path.join(stage, 'recipe.json'), output = path.join(stage, 'output');
    await fs.writeFile(recipePath, JSON.stringify(recipe), {flag: 'wx', mode: 0o600});
    const home = path.join(stage, 'home'), temporary = path.join(stage, 'tmp');
    await fs.mkdir(home); await fs.mkdir(temporary);
    const env: NodeJS.ProcessEnv = {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, NO_COLOR: '1', NODE_ENV: 'production',
        ...(process.env.NPM_CLI_JS ? {NPM_CLI_JS: process.env.NPM_CLI_JS} : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS ? {NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS} : {})};
    // Keep the configured network route without inheriting service credentials or caller npm configuration.
    for (const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy']) {
        if (process.env[key] !== undefined) { env[key] = process.env[key]; }
    }
    if (process.env.NODE_USE_ENV_PROXY === '1') { env.NODE_USE_ENV_PROXY = '1'; }
    await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const args=['--recipe',recipePath,'--output',output,'--progress'];
        const child = spawn(process.execPath, execution?[path.join(__dirname,'build-supervisor.js'),builderScript(),execution.nonce,...args]:['--require', path.join(__dirname, 'build-guardian.js'), builderScript(),...args], {cwd: stage, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
        if(execution)supervised.add(child);
        observe(child);
        let reason = '', checking = false, finished = false, pending = '', stdoutBytes = 0, completed = 0,ready=false;
        let startupFailure:unknown,startAdmitted=false,reaped=false;
        let progressChain = Promise.resolve();
        const fail = (message: string) => {if (finished) {return;} reason ||= message; stopBuildProcess(child); };
        const abort=()=>fail('Сборка отменена.');
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
        if(execution)child.on('message',message=>{
            if(message&&typeof message==='object'&&(message as {type?:unknown}).type==='reaped'&&(message as {nonce?:unknown}).nonce===execution.nonce){reaped=true;execution.reaped?.();return;}
            if(ready||!message||typeof message!=='object'||(message as {type?:unknown}).type!=='ready')return;ready=true;
            void execution.markStarted().then(()=>{startAdmitted=true;if(!finished&&!reason&&!signal?.aborted&&child.connected)child.send({type:'start'});else stopBuildProcess(child);})
                .catch(error=>{startupFailure=error;fail('Не удалось подтвердить запуск сборки.');});
        });
        const timeout = setTimeout(() => fail('Сборка превысила лимит времени 20 минут.'), 20 * 60 * 1000);
        const monitor = setInterval(() => {
            if (checking) { return; }
            checking = true;
            void stagingBytes(stage).then(async () => {
                const disk = await fs.statfs(stage, {bigint: true});
                if (disk.bavail * disk.bsize < 1024n ** 3n) { fail('На диске осталось меньше резервного 1 ГиБ. Сборка остановлена.'); }
            }).catch(error => fail(error instanceof Error ? error.message : 'Проверка staging не выполнена.')).finally(() => {checking = false;});
        }, 2000);
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes > 1024 * 1024) {fail('Сборщик превысил лимит служебного вывода.'); return;}
            pending += chunk;
            if (pending.length > 65536 && !pending.includes('\n')) {fail('Некорректный служебный вывод сборщика.'); return;}
            const lines = pending.split('\n'); pending = lines.pop() ?? '';
            for (const line of lines) {
                let event: BuildProgress | {type:'build-error';code?:unknown};
                try {event = JSON.parse(line) as typeof event;} catch {continue;}
                if(event?.type==='build-error'){
                    if(typeof event.code==='string'&&Object.prototype.hasOwnProperty.call(buildFailures,event.code))reason||=buildFailures[event.code];
                    continue;
                }
                if (!event || event.type !== 'build-progress' || !config.targets.includes(event.target) || event.total !== config.targets.length
                    || !Number.isInteger(event.completed) || event.completed < completed || event.completed > event.total) {continue;}
                completed = event.completed;
                if (onProgress) {progressChain = progressChain.then(() => onProgress(event)).catch(() => fail('Не удалось сохранить прогресс сборки. Сборка остановлена.'));}
            }
        });
        child.stderr?.resume();
        const cleanup = () => {finished = true; clearTimeout(timeout); clearInterval(monitor);signal?.removeEventListener('abort',abort); observe(undefined);};
        child.once('error', () => {cleanup(); reject(new Error('Не удалось запустить серверный сборщик.'));});
        child.once('close', code => {void progressChain.then(async() => {
            if(execution&&startAdmitted&&!reaped){reaped=await hasBuildReapProof(stage,execution.nonce);if(reaped)execution.reaped?.();
                if(!reaped&&!(process.platform==='win32'&&code===0&&!reason)){cleanup();reject(new BuildProcessUnreapedError());return;}}
            cleanup();code===0&&!reason?resolve():reject(startupFailure??new Error(reason||'Сборка не выполнена. Проверьте npm-пакет, файл запуска и его зависимости.'));
        }).catch(()=>{cleanup();reject(new BuildProcessUnreapedError());});});
    });
    await stagingBytes(stage);
    return path.join(output, 'asset.json');
}
