import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateAsset} from '@neurocenter/asset-contract';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import {readyManifest} from './manifest.mjs';
import {RuntimeVerificationError,RuntimeVerificationScope,configureRuntimeSandbox,assertRuntimeSandbox} from './verify-runtime-process.mjs';
import {verifyMcpRuntime} from './verify-runtime-mcp.mjs';
import {codexRuntimeEntrypoint} from './verify-runtime-codex.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const messages={
    'integrity-failed':'Повторите сборку: asset.json, исходный снимок или runtime-архив не совпадает с закреплённой поставкой.',
    'unsupported-kind':'Общая проверка запуска принимает только MCP и OpenCode plugin.',
    'no-host-artifact':'Нет готового артефакта для ОС и архитектуры проверяющего сервера. Соберите этот target на совместимом runner.',
    'entrypoint-unsupported':'Нужна готовая точка входа JS либо исполняемый MCP-артефакт для текущей платформы.',
    'configuration-required':'Для запуска нужна локальная конфигурация. Настройте отдельный профиль проверки; личные ключи сервера не передаются.',
    'unsafe-environment':'Пакет пытается заменить системные пути или загрузчики. Удалите такие переменные из recipe.',
    'isolation-unavailable':'Нужен поддерживаемый OS sandbox runner. На Linux требуется bwrap с user/PID/network namespaces; на macOS — работающий sandbox-exec. Запуск без OS-изоляции запрещён.',
    'runtime-unavailable':'Не удалось запустить закреплённый runtime внутри OS sandbox.',
    'runtime-crashed':'Runtime завершился до успешного окончания handshake и списка инструментов. Проверьте entrypoint и автономные зависимости.',
    'timeout':'Запуск превысил отведённое время. Проверьте зависание инициализации; сеть запрещена; дочерние процессы доступны только в Linux PID namespace.',
    'cancelled':'Проверка отменена; публикация кандидата не разрешена.',
    'output-limit':'Runtime превысил допустимый объём диагностического вывода.',
    'mcp-invalid-protocol':'MCP вывел неверный JSON-RPC в stdout. Логи должны идти в stderr.',
    'mcp-initialize-failed':'MCP initialize не завершился. Проверьте stdio-протокол и автономный запуск без ключей.',
    'mcp-tools-unavailable':'MCP не объявил capability tools.',
    'mcp-list-failed':'MCP tools/list не прошёл проверку протокола.',
    'mcp-list-limit':'Список MCP-инструментов слишком велик или курсор повторяется.',
    'mcp-no-tools':'MCP tools/list вернул пустой список инструментов.',
    'plugin-invalid-export':'Плагин должен экспортировать фабрику hooks либо объект с server-фабрикой.',
    'plugin-invalid-hooks':'Фабрика плагина вернула hooks, не соответствующие поддерживаемому контракту OpenCode.',
    'plugin-no-hooks':'Фабрика плагина не зарегистрировала ни одного рабочего hook или инструмента.',
    'plugin-shell-unavailable':'Фабрика требует shell при регистрации. Нужен runner с изолированной поддержкой дочерних процессов.',
    'plugin-dependency-missing':'Не найдена автономная зависимость плагина. Включите её в готовую поставку.',
    'plugin-initialization-failed':'Фабрика плагина завершилась с ошибкой. Проверьте минимальный SDK context; сеть запрещена; на macOS также запрещены дочерние процессы.',
    'plugin-result-invalid':'Runner плагина не вернул корректный результат инициализации.',
    'cleanup-failed':'Не удалось подтвердить завершение собственных процессов или удалить временный профиль. Публикация запрещена; проверьте runner.',
    'verification-failed':'Общая проверка запуска не завершилась; пересоберите кандидат и повторите проверку.',
};

function hostTarget() {
    if(process.platform!=='linux')return `${process.platform}-${process.arch}`;
    return `linux-${process.arch}-${process.report?.getReport().header.glibcVersionRuntime?'glibc':'musl'}`;
}
async function pinnedManifest(filename) {
    const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
        const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size<1||before.size>16*1024*1024)throw new Error();
        const bytes=await handle.readFile(),after=await handle.stat();
        if(bytes.length!==before.size||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs)throw new Error();
        return {sha256:hash(bytes),asset:validateAsset(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)))};
    } finally {await handle.close();}
}
function packageEnvironment(config,base) {
    const env=config?.env??{};
    const forbidden=/^(?:HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|XDG_.*|OPENCODE_.*|BUN_.*|NPM_.*|PIP_.*|PYTHON.*|LD_.*|DYLD_.*)$/i;
    if(Object.keys(env).some(key=>forbidden.test(key)))throw new RuntimeVerificationError('unsafe-environment');
    if(Object.values(env).some(value=>typeof value!=='string'||/\{env:|\$\{/.test(value)))throw new RuntimeVerificationError('configuration-required');
    return {...base,...env};
}
async function materialize(tool,root,target) {
    const directory=path.join(root,'package');await fs.mkdir(directory,{mode:0o700});
    if(tool.artifacts.length) {
        const selected=tool.artifacts.find(item=>item.descriptor.target===target);
        if(!selected)throw new RuntimeVerificationError('no-host-artifact');
        await runtime.inspectRuntimeArchive(selected.archivePath,selected.descriptor,{destination:directory});
        return {entrypoint:path.join(directory,selected.descriptor.entrypoint),executable:!!selected.descriptor.executable,target};
    }
    const config=tool.publication.config,entrypoint=config?.entrypoint;
    if(!entrypoint||!runtime.portablePath(entrypoint)||!tool.publication.files.some(file=>file.path===entrypoint)
        ||!/[.](?:[cm]?js)$/i.test(entrypoint)||tool.publication.kind==='mcp'&&config.command!=='node')throw new RuntimeVerificationError('entrypoint-unsupported');
    for(const file of tool.publication.files) {
        if(!runtime.portablePath(file.path))throw new RuntimeVerificationError('integrity-failed');
        const destination=path.join(directory,file.path);await fs.mkdir(path.dirname(destination),{recursive:true,mode:0o700});
        await fs.writeFile(destination,file.content,{flag:'wx',mode:0o400});
    }
    return {entrypoint:path.join(directory,entrypoint),executable:false,target};
}
async function verifyPluginRuntime(scope,profile,entrypoint,nodeExecutable,checks) {
    const runner=path.join(profile.root,'verify-plugin.mjs');
    await fs.copyFile(fileURLToPath(new URL('./verify-runtime-plugin.mjs',import.meta.url)),runner,constants.COPYFILE_EXCL);
    const child=scope.start(nodeExecutable,[runner,entrypoint,profile.project,profile.home],profile,{ipc:true});
    let bytes=0,chunks=[];
    child.stdio[3].on('data',chunk=>{bytes+=chunk.length;if(bytes>4096){child.failure=new RuntimeVerificationError('plugin-result-invalid');scope.stop(child);}else chunks.push(chunk);});
    await scope.wait(child.finished);if(child.failure)throw child.failure;
    let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RuntimeVerificationError('plugin-result-invalid');}
    if(result?.schemaVersion!==1||typeof result.ok!=='boolean')throw new RuntimeVerificationError('plugin-result-invalid');
    if(!result.ok)throw new RuntimeVerificationError(Object.hasOwn(messages,result.code)&&String(result.code).startsWith('plugin-')?result.code:'plugin-initialization-failed');
    if(child.runtimeExitCode!==0||!Number.isSafeInteger(result.hooks)||result.hooks<1||result.hooks>1000||!Number.isSafeInteger(result.tools)||result.tools<0||result.tools>1000)throw new RuntimeVerificationError('plugin-result-invalid');
    checks.pluginFactory=true;checks.hooks=true;return {tools:result.tools,pluginHooks:result.hooks};
}

/** Byte-pinned common startup gate. Only the host target is executed, inside a mandatory OS sandbox. */
export async function verifyBuiltRuntime(manifestFile,{signal,timeoutMs=15000,integrityTimeoutMs=300000,maxOutputBytes=262144,candidateIdentity}={}) {
    const started=Date.now(),target=hostTarget();
    const report={schemaVersion:1,ok:false,status:'failed',candidate:{identity:null,sourceDigest:null,assetId:null,version:null,manifestSha256:null},
        hostTarget:target,testedTarget:null,untestedTargets:[],isolation:{kind:'unavailable',osEnforced:false,network:'denied',childProcesses:'denied',disposableProfile:true},
        checks:{integrity:false,initialize:false,toolsList:false,pluginFactory:false,hooks:false},counts:{tools:0,pluginHooks:0},diagnostics:[],
        startedAt:new Date(started).toISOString(),finishedAt:null,durationMs:0};
    let root,scope;
    try {
        if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isSafeInteger(integrityTimeoutMs)||integrityTimeoutMs<1||integrityTimeoutMs>300000||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1024||maxOutputBytes>1048576)throw new RuntimeVerificationError('verification-failed');
        scope=new RuntimeVerificationScope({signal,timeoutMs:integrityTimeoutMs,maxOutputBytes});scope.remaining();
        const filename=path.resolve(manifestFile),before=await pinnedManifest(filename);
        const [tool]=await scope.wait(readyManifest(filename)),after=await pinnedManifest(filename);
        if(before.sha256!==after.sha256||!isDeepStrictEqual(before.asset,tool.asset))throw new RuntimeVerificationError('integrity-failed');
        const asset=tool.asset;
        report.candidate={identity:typeof candidateIdentity==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidateIdentity)?candidateIdentity:`${asset.id}@${asset.version}`,
            sourceDigest:asset.source.sha256??hash(JSON.stringify(canonical(asset.source))),assetId:asset.id,version:asset.version,manifestSha256:before.sha256};
        report.untestedTargets=tool.artifacts.map(item=>item.descriptor.target);report.checks.integrity=true;
        if(!['mcp','plugin'].includes(tool.publication.kind))throw new RuntimeVerificationError('unsupported-kind');
        if(tool.publication.kind==='mcp'&&tool.publication.config?.transport!=='stdio')throw new RuntimeVerificationError('entrypoint-unsupported');
        root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-package-runtime-')));await fs.chmod(root,0o700);
        const selected=await materialize(tool,root,target),nodeExecutable=await fs.realpath(process.execPath);
        if(!selected.executable&&!/[.](?:[cm]?js)$/i.test(selected.entrypoint)||tool.publication.kind==='plugin'&&selected.executable)throw new RuntimeVerificationError('entrypoint-unsupported');
        const profile=await configureRuntimeSandbox(root,nodeExecutable);profile.env=packageEnvironment(tool.publication.config,profile.env);
        scope.resetDeadline(timeoutMs);await assertRuntimeSandbox(profile,nodeExecutable,scope);
        report.isolation.kind=profile.adapter;report.isolation.osEnforced=true;report.isolation.childProcesses=profile.adapter==='linux-bwrap'?'pid-namespace':'denied';
        report.testedTarget=selected.target;report.untestedTargets=report.untestedTargets.filter(item=>item!==selected.target);
        scope.resetDeadline(timeoutMs);
        if(tool.publication.kind==='mcp')report.counts.tools=await verifyMcpRuntime(scope,profile,selected.executable?selected.entrypoint:nodeExecutable,
            [...(selected.executable?[]:[selected.entrypoint]),...(tool.publication.config.args??[])],report.checks);
        else {
            const entrypoint=await scope.wait(codexRuntimeEntrypoint(tool,selected.entrypoint,profile,nodeExecutable));
            report.counts=await verifyPluginRuntime(scope,profile,entrypoint,nodeExecutable,report.checks);
        }
        scope.remaining();report.ok=true;report.status='passed';
    } catch(error) {
        const code=error instanceof RuntimeVerificationError?error.code:report.checks.integrity?'verification-failed':'integrity-failed';
        report.status=code==='cancelled'?'cancelled':'failed';report.diagnostics=[{code,message:messages[code]??messages['verification-failed']}];
    } finally {
        try{await scope?.close();if(root)await fs.rm(root,{recursive:true,force:true,maxRetries:2});}
        catch{report.ok=false;report.status='failed';report.diagnostics=[{code:'cleanup-failed',message:messages['cleanup-failed']}];}
        report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-started;
    }
    return report;
}
