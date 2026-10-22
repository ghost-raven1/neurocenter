import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {bridgeRuntimeCached} from '../bridge-runtime-artifacts.mjs';
import {verifyBridgeBuild} from '../bridge-build-integrity.mjs';
import {assertBridgeSnapshot,bridgeFileSnapshot,expectedBridgeLauncher,expectedBridgeRegistration,installedBridgeSettings,retainBridgeSettings,restoreBridgeFile} from './dev-bridge-settings.mjs';

const execute=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const missing=error=>error.code==='ENOENT';
async function exists(file){try{return await fs.lstat(file);}catch(error){if(missing(error))return;throw error;}}
async function regular(file){const value=await fs.lstat(file);if(!value.isFile()||value.isSymbolicLink()||value.nlink!==1)throw Error('Необычный файл локальной поставки: '+file);return value;}
async function json(file){const info=await regular(file);if(info.size>65536)throw Error('Метаданные локальной поставки слишком велики.');return JSON.parse(await fs.readFile(file,'utf8'));}
const bundledNode=install=>path.join(install,'bin',process.platform==='win32'?'node.exe':'node');
const installedEntry=install=>path.join(install,'dist/index.js');
const hostTarget=()=>`${process.platform==='win32'?'windows':process.platform}-${process.arch}${process.platform==='linux'&&!process.report.getReport().header.glibcVersionRuntime?'-musl':''}`;
/** Runtime HOME belongs to the MCP entry; management writes belong to the selected caller configuration. */
function managementEnvironment(runtime,environment,home){
    const control={...runtime,HOME:home,USERPROFILE:home};
    if(environment.XDG_CONFIG_HOME===undefined)delete control.XDG_CONFIG_HOME;
    else control.XDG_CONFIG_HOME=environment.XDG_CONFIG_HOME;
    return control;
}

/** Every CLI command has a deadline; JSON success is required in addition to exit status. */
async function runCommand(command,args,environment,timeout=20000){
    return(await execute(command,args,{env:environment,encoding:'utf8',timeout,maxBuffer:1024*1024,killSignal:'SIGTERM'})).stdout;
}
async function cli(run,install,args,environment){
    let output;try{output=await run(bundledNode(install),[installedEntry(install),...args],environment,args[0]==='--prepare-upgrade'?75000:25000);}
    catch(error){let rejected;try{rejected=JSON.parse(error.stdout);}catch{/* No JSON ACK: retain the uncertain command outcome. */}if(rejected?.ok===false)throw Error(rejected.error||'Мост отказал в '+args[0]);throw error;}
    let result;try{result=JSON.parse(output);}catch{throw Error('Мост вернул некорректный JSON: '+args[0]);}
    if(result?.ok!==true)throw Error(typeof result?.error==='string'?result.error:'Мост не подтвердил '+args[0]);
    return result;
}
async function unpack({archive,version,buildId,target},temporary){
    const expected=`neurocenter-asset-sync-${target}-${version}.tgz`;
    if(target!==hostTarget()||path.basename(archive)!==expected||!/^\d+\.\d+\.\d+$/.test(version)||!/^[a-f0-9]{64}$/.test(buildId))throw Error('Локальная поставка не соответствует текущей платформе, версии или сборке.');
    if(!await bridgeRuntimeCached({directory:path.dirname(archive),target,version,buildId}))throw Error('Локальный архив моста не прошёл SHA и проверку метаданных.');
    const metadata=await json(archive+'.json'),copy=path.join(temporary,'bridge.tgz');await fs.copyFile(archive,copy);
    const digest=createHash('sha256');for await(const bytes of createReadStream(copy))digest.update(bytes);
    if(digest.digest('hex')!==metadata.sha256||(await regular(copy)).size!==metadata.bytes)throw Error('Архив изменился после проверки SHA.');
    const listing=(await execute('tar',['-tzf',copy],{timeout:60000,maxBuffer:32*1024**2})).stdout.trimEnd().split('\n');
    const paths=new Set();for(const entry of listing){
        const name=entry.replace(/\/$/,'');
        if(!name||/[\\\x00-\x1f\x7f]/.test(name)||path.posix.isAbsolute(name)||/^[a-zA-Z]:/.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..')||paths.has(name)||!['bin','dist','node_modules','package.json','package-lock.json','runtime.json'].includes(name.split('/')[0]))throw Error('Небезопасный путь в локальном архиве моста.');
        paths.add(name);
    }
    const details=(await execute('tar',['-tvzf',copy],{timeout:60000,maxBuffer:32*1024**2})).stdout.trimEnd().split('\n');
    if(details.length!==listing.length||details.some(line=>!/^[-d]/.test(line)))throw Error('Ссылки и специальные файлы в архиве моста запрещены.');
    const staged=path.join(temporary,'package');await fs.mkdir(staged,{mode:0o700});
    await execute('tar',['-xzf',copy,'-C',staged],{timeout:120000,maxBuffer:1024*1024});
    for(const name of await fs.readdir(staged,{recursive:true})){
        const file=path.join(staged,name),info=await fs.lstat(file);
        if(info.isSymbolicLink()||!info.isDirectory()&&(!info.isFile()||info.nlink!==1))throw Error('Необычный файл в распакованном мосте.');
    }
    const manifest=await json(path.join(staged,'package.json')),runtime=await json(path.join(staged,'runtime.json')),build=await verifyBridgeBuild(path.join(staged,'dist'),version);
    if(manifest.name!=='neurocenter-asset-sync'||manifest.version!==version||runtime.version!==version||runtime.target!==target||runtime.buildId!==buildId||build.buildId!==buildId)throw Error('Распакованный мост не совпал с исходной сборкой.');
    await regular(bundledNode(staged));await regular(path.join(staged,'dist/bridge-cli.js'));
    return{directory:staged,receipt:{schemaVersion:1,version,buildId,target,sha256:metadata.sha256}};
}
function startWorker(install,environment){
    const child=spawn(bundledNode(install),[installedEntry(install),'--worker'],{env:environment,detached:true,stdio:'ignore'});
    let failure;child.on('error',error=>{failure=error;});child.unref();return{pid:child.pid,alive(){if(failure)throw failure;return child.exitCode===null&&child.signalCode===null;}};
}
async function workerReady(worker,state,version,buildId){
    const deadline=Date.now()+10000;
    do{
        if(!Number.isSafeInteger(worker.pid)||!worker.alive())throw Error('Обновлённый worker завершился до подтверждения запуска.');
        try{
            const lock=(await fs.readFile(path.join(state,'worker.lock'),'utf8')).trim(),value=await json(path.join(state,'worker-version.json'));
            if(lock===String(worker.pid)&&value.pid===worker.pid&&value.version===version&&value.buildId===buildId&&worker.alive())return;
        }catch(error){if(!missing(error))throw error;}
        await sleep(100);
    }while(Date.now()<deadline);
    throw Error('Worker не подтвердил PID, версию и сборку за 10 секунд.');
}
async function takeLock(lock){
    await fs.mkdir(lock,{mode:0o700});
    const file=path.join(lock,'owner.pid');let handle,owned;
    try{handle=await fs.open(file,'wx',0o600);owned=await handle.stat();await handle.writeFile(String(process.pid)+'\n');await handle.sync();}
    catch(error){
        if(owned)try{const current=await fs.lstat(file);if(current.dev===owned.dev&&current.ino===owned.ino)await fs.unlink(file);else error.message+=' Файл owner.pid уже заменён: '+lock;}catch(cleanup){if(!missing(cleanup))error.message+=' Не удалось убрать собственный owner.pid: '+lock;}
        try{await fs.rmdir(lock);}catch{error.message+=' Не удалось убрать собственную блокировку: '+lock;}
        throw error;
    }finally{await handle?.close();}
}
async function releaseLock(lock){await fs.unlink(path.join(lock,'owner.pid'));await fs.rmdir(lock);}
async function assertPublished(install,published,version,buildId){
    const info=await fs.lstat(install);
    if(!info.isDirectory()||info.isSymbolicLink()||info.dev!==published.dev||info.ino!==published.ino)throw Error('Установленный runtime уже заменён другим процессом; чужая версия не откатывается.');
    const manifest=await json(path.join(install,'package.json')),build=await verifyBridgeBuild(path.join(install,'dist'),version);
    if(manifest.version!==version||manifest.name!=='neurocenter-asset-sync'||build.buildId!==buildId)throw Error('Установленный runtime изменился после публикации; автоматический откат запрещён.');
}
async function saveRecoveryOriginals(temporary,config,launcher){
    for(const[name,snapshot]of[['original-opencode.jsonc',config],['original-launcher',launcher]])if(snapshot.bytes!==null)await fs.writeFile(path.join(temporary,name),snapshot.bytes,{flag:'wx',mode:0o600,flush:true});
    await fs.writeFile(path.join(temporary,'recovery.json'),JSON.stringify({config:{path:config.file,existed:config.bytes!==null,mode:config.mode},launcher:{path:launcher.file,existed:launcher.bytes!==null,mode:launcher.mode}},null,2)+'\n',{flag:'wx',mode:0o600,flush:true});
}
/** A marker alone cannot authorize recovery: the owner must be alive, same-UID and running this exact entry. */
async function ownsRunningWorker(pid,entry){
    try{
        process.kill(pid,0);
        if(process.platform==='linux'){
            const [owner,command]=await Promise.all([fs.stat(`/proc/${pid}`),fs.readFile(`/proc/${pid}/cmdline`,'utf8')]),args=command.replace(/\0$/,'').split('\0');
            return owner.uid===process.getuid()&&args.at(-2)===entry&&args.at(-1)==='--worker'&&!args.slice(1,-2).some(arg=>/^(?:--(?:eval|print)(?:=|$)|-[^-]*[ep])/.test(arg));
        }
        const command=(await execute('ps',['-ww','-p',String(pid),'-o','uid=','-o','args='],{encoding:'utf8',timeout:3000,maxBuffer:65536,env:{...process.env,LC_ALL:'C.UTF-8'}})).stdout.trim(),parts=/^(\d+)\s+([\s\S]*)$/.exec(command),escaped=entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),match=new RegExp('(?:^|\\s)(?:"'+escaped+'"|'+escaped+')\\s+--worker$').exec(parts?.[2]||'');
        return Number(parts?.[1])===process.getuid()&&!!match&&!/(?:^|\s)(?:--(?:eval|print)(?:=|\s|$)|-[^-\s]*[ep])/.test(parts[2].slice(0,match.index));
    }catch{return false;}
}

/** A lost ACK permits restart only after resume, with the original runtime and a proven exited owner. */
async function stoppedOriginalWorker(install,state,original){
    if(!original?.worker)return false;
    const current=await fs.lstat(install);
    if(current.dev!==original.directory.dev||current.ino!==original.directory.ino||await exists(path.join(state,'worker.lock')))return false;
    await assertBridgeSnapshot(original.package);await assertBridgeSnapshot(original.build);
    try{process.kill(original.worker,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}
}

/** Update an existing installation only; saved pairing stays outside the replaceable runtime tree. */
export async function updateInstalledDevBridge({root,archive,version,buildId,target,environment=process.env,output},dependencies={}){
    const run=dependencies.runCommand||runCommand,start=dependencies.startWorker||startWorker,ready=dependencies.workerReady||workerReady;
    const home=environment.HOME||environment.USERPROFILE||os.homedir(),install=path.resolve(environment.INSTALL_DIR||path.join(home,'.opencode/neurocenter-asset-sync'));
    if(!await exists(install)){output?.info?.('Мост','Локальный мост не установлен; новая поставка готова.');return{updated:false,reason:'not-installed',installDir:install};}
    if(!(await fs.lstat(install)).isDirectory()||(await fs.lstat(install)).isSymbolicLink()||await fs.realpath(install)!==install)throw Error('Папка установленного моста должна быть обычным каталогом без ссылок.');
    const repository=await fs.realpath(root),protectedPaths=[path.join(repository,'mcp/neurocenter-asset-sync'),path.join(repository,'bridge-dist'),path.join(repository,'.run/dev-bridge'),path.dirname(path.resolve(archive))];
    if(protectedPaths.some(file=>file===install||file.startsWith(install+path.sep)||install.startsWith(file+path.sep)))throw Error('INSTALL_DIR пересекается с исходниками или поставкой dev-моста; их замена запрещена.');
    const temporary=await fs.mkdtemp(path.join(path.dirname(install),'.neurocenter-dev-install-')),lock=install+'.install-lock';
    let locked=false,prepared=false,prepareAttempted=false,prepareConfirmed=false,resumed=false,restartUnknown=false,published=false,publication,original,previous,settings,launcherBefore,configAfter,launcherAfter,staged,resumeInstall,restart=false,state,rollbackNeeded=false,keepTemporary=false,withConfigLock;
    const prepare=async location=>{
        prepareAttempted=true;resumed=false;
        const result=await cli(run,location,['--prepare-upgrade',installedEntry(install)],settings.environment);
        if(typeof result.paused!=='boolean')throw Error('Мост не подтвердил состояние паузы обновления.');
        prepareAttempted=false;return result.paused;
    };
    try{
        const unpacked=await unpack({archive:path.resolve(archive),version,buildId,target},temporary);staged=unpacked.directory;resumeInstall=staged;
        const runtime=await run(bundledNode(staged),['--version'],environment,20000);
        const platform=await run(bundledNode(staged),['-p','process.platform+":"+process.arch'],environment,20000);
        if(!/^v24\.\d+\.\d+\s*$/.test(runtime)||platform.trim()!==process.platform+':'+process.arch)throw Error('Runtime моста не запускается на этом компьютере.');
        const jsonc=createRequire(path.join(staged,'package.json'))('jsonc-parser');
        ({withGlobalConfigLock:withConfigLock}=await import(pathToFileURL(path.join(staged,'dist/lib/global-config-lock.js')).href));
        await takeLock(lock);locked=true;
        await fs.writeFile(path.join(staged,'.neurocenter-dev-supply.json'),JSON.stringify(unpacked.receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
        const old=await json(path.join(install,'package.json'));
        if(old.name!=='neurocenter-asset-sync'||!/^0\.(?:9|[1-9]\d)\.\d+$/.test(old.version)||old.version.split('.').map(Number).some((part,i,all)=>all.slice(0,i).every((n,j)=>n===Number(version.split('.')[j]))&&part>Number(version.split('.')[i])))throw Error('Установленный мост несовместим или новее локальной сборки.');
        settings=await installedBridgeSettings({install,home,environment,jsonc});const controlEnvironment=managementEnvironment(settings.environment,environment,home);
        const runtimeHomeVariable=process.platform==='win32'?'USERPROFILE':'HOME';
        if(settings.environment[runtimeHomeVariable]==='')throw Error('Пустой runtime '+runtimeHomeVariable+' не поддерживается: сохранённые настройки не изменены.');
        const launcher=path.join(home,'.local/bin','neurocenter-bridge'+(process.platform==='win32'?'.cmd':''));launcherBefore=await bridgeFileSnapshot(launcher);
        if(launcherBefore.bytes&&!launcherBefore.bytes.toString('utf8').includes('Neurocenter bridge command v1'))throw Error('Команда neurocenter-bridge занята другой программой.');
        await saveRecoveryOriginals(temporary,settings.config.snapshot,launcherBefore);
        const runtimeHome=(process.platform==='win32'?settings.environment.USERPROFILE:settings.environment.HOME)||home;
        state=path.join(settings.environment.NEUROCENTER_BRIDGE_HOME||path.join(runtimeHome,'.config/neurocenter/bridge'),createHash('sha256').update(settings.siteUrl).digest('hex').slice(0,20));
        restart=(await bridgeFileSnapshot(path.join(state,'credentials.json'))).bytes!==null;
        original={directory:await fs.lstat(install),package:await bridgeFileSnapshot(path.join(install,'package.json')),build:await bridgeFileSnapshot(path.join(install,'dist/build.json'))};
        try{const workerLock=await bridgeFileSnapshot(path.join(state,'worker.lock')),raw=Number(workerLock.bytes?.toString('utf8').trim()),marker=await json(path.join(state,'worker-version.json'));if(Number.isSafeInteger(raw)&&raw>1&&raw!==process.pid&&marker.pid===raw&&marker.version===old.version&&marker.buildId===JSON.parse(original.build.bytes).buildId&&await ownsRunningWorker(raw,installedEntry(install))){await assertBridgeSnapshot(workerLock);original.worker=raw;}}catch{/* Optional proof cannot be inferred from an absent or damaged worker marker. */}
        prepared=await prepare(staged);prepareConfirmed=true;
        await assertBridgeSnapshot(settings.config.snapshot);await assertBridgeSnapshot(launcherBefore);await assertBridgeSnapshot(settings.marker);
        publication=await fs.lstat(staged);const previousPath=path.join(temporary,'previous');await fs.rename(install,previousPath);previous=previousPath;
        try{await fs.rename(staged,install);}catch(error){await fs.rename(previous,install);previous=undefined;throw error;}
        published=true;rollbackNeeded=true;resumeInstall=install;const located=await fs.lstat(install);
        if(located.dev!==publication.dev||located.ino!==publication.ino)throw Error('Установленный runtime заменён во время публикации.');
        const expectedConfig=expectedBridgeRegistration(settings,jsonc,install);
        try{await cli(run,install,['--init'],controlEnvironment);}
        finally{
            const after=await selectedAfter(settings,home,environment);
            if(after.bytes?.toString('utf8')===expectedConfig)configAfter=after;
            else await assertBridgeSnapshot(settings.config.snapshot);
        }
        if(!configAfter)throw Error('OpenCode не подтвердил ожидаемую регистрацию моста.');
        configAfter=await retainBridgeSettings({settings,home,environment,jsonc,withConfigLock,install,expected:configAfter});
        try{await run(bundledNode(install),[path.join(install,'dist/bridge-cli.js'),'--install-command'],controlEnvironment,25000);}
        finally{
            const after=await bridgeFileSnapshot(launcherBefore.file);
            if(after.bytes?.toString('utf8')===expectedBridgeLauncher(install))launcherAfter=after;
            else await assertBridgeSnapshot(launcherBefore);
        }
        if(!launcherAfter?.bytes)throw Error('Короткая команда моста не зарегистрирована.');
        await cli(run,install,['--finish-upgrade'],settings.environment);prepared=false;resumed=true;
        await releaseLock(lock);locked=false;
        if(restart)await ready(start(install,settings.environment),state,version,buildId);
        rollbackNeeded=false;
        const retained=path.join(path.dirname(install),'.neurocenter-previous-'+path.basename(temporary));await fs.rename(previous,retained);previous=undefined;
        output?.success?.('Локальный мост обновлён; площадка, подключение и настройки сохранены.');
        return{updated:true,installDir:install,version,buildId,target,workerRestarted:restart,previousDir:retained};
    }catch(cause){
        const problems=[];
        if(rollbackNeeded){
            if(!locked){try{await takeLock(lock);locked=true;await assertPublished(install,publication,version,buildId);prepared=await prepare(install);}catch(error){problems.push('Повторная блокировка/остановка не подтверждена: '+error.message);}}
            if(locked&&!problems.length){
                try{await assertPublished(install,publication,version,buildId);}catch(error){problems.push(error.message);}
            }
            if(locked&&!problems.length){
                if(configAfter)try{await withConfigLock(settings.config.snapshot.file,()=>restoreBridgeFile(settings.config.snapshot,configAfter));}catch(error){problems.push('Настройки не перезаписаны: '+error.message);}
                if(launcherAfter)try{await restoreBridgeFile(launcherBefore,launcherAfter);}catch(error){problems.push('Команда не перезаписана: '+error.message);}
                try{resumeInstall=path.join(temporary,'failed');await fs.rename(install,resumeInstall);await fs.rename(previous,install);previous=undefined;published=false;}catch(error){problems.push('Откат файлов не завершён: '+error.message);}
            }
        }
        if((prepared||prepareAttempted)&&settings){try{await cli(run,await exists(resumeInstall)?resumeInstall:install,['--finish-upgrade'],settings.environment);prepared=false;resumed=true;}catch(error){problems.push('Снятие паузы не подтверждено: '+error.message);}}
        if(restart&&!published&&!prepareConfirmed&&prepareAttempted&&resumed)try{restartUnknown=await stoppedOriginalWorker(install,state,original);}catch(error){problems.push('Остановка прежнего worker не подтверждена: '+error.message);}
        if(locked){try{await releaseLock(lock);locked=false;}catch(error){problems.push('Блокировка сохранена: '+error.message);}}
        if(restart&&(prepareConfirmed||restartUnknown)&&!published&&!prepared){try{const old=await json(path.join(install,'package.json')),build=await json(path.join(install,'dist/build.json'));await ready(start(install,settings.environment),state,old.version,build.buildId);}catch(error){problems.push('Запуск прежнего worker не подтверждён: '+error.message);}}
        if(previous||problems.length){keepTemporary=true;Object.assign(cause,{recoveryDirectory:temporary});}
        if(problems.length)cause.message+=' '+problems.join('; ');
        if(keepTemporary)cause.message+=' Каталог восстановления: '+temporary;
        throw cause;
    }finally{
        if(locked)await releaseLock(lock);
        if(!previous&&!keepTemporary)await fs.rm(temporary,{recursive:true,force:true});
    }
}
async function selectedAfter(settings,home,environment){
    const {selectedBridgeConfig}=await import('./dev-bridge-settings.mjs');const selected=await selectedBridgeConfig(home,environment);
    if(selected.logical!==settings.config.logical||selected.snapshot.file!==settings.config.snapshot.file)throw Error('Путь OpenCode изменился во время регистрации.');
    return selected.snapshot;
}
