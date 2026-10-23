const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {createHash,randomUUID}=require('node:crypto'),{spawnSync,spawn}=require('node:child_process');
const limit=8*1024*1024,name='neurocenter-asset-sync',nodeName=process.platform==='win32'?'node.exe':'node';
const changed=()=>Error('Конфигурация OpenCode изменилась. Файлы не заменены; повторите установку.');
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.nlink].join(':');
const identity=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.mode,s.nlink].join(':');
function snapshot(file){
    let before;try{before=fs.lstatSync(file,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!before.isFile()||before.nlink!==1n||before.size>BigInt(limit))throw Error('Небезопасный файл конфигурации OpenCode.');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0)|(fs.constants.O_NONBLOCK||0));
    try{
        const opened=fs.fstatSync(fd,{bigint:true});if(stamp(opened)!==stamp(before))throw changed();
        const bytes=Buffer.alloc(Number(opened.size)+1);let length=0;
        while(length<bytes.length){const read=fs.readSync(fd,bytes,length,bytes.length-length,null);if(!read)break;length+=read;}
        if(BigInt(length)!==opened.size||stamp(fs.fstatSync(fd,{bigint:true}))!==stamp(opened)||stamp(fs.lstatSync(file,{bigint:true}))!==stamp(opened))throw changed();
        const text=bytes.subarray(0,length).toString('utf8');if(!Buffer.from(text).equals(bytes.subarray(0,length)))throw Error('Некорректная кодировка конфигурации OpenCode.');
        return{stamp:stamp(opened),identity:identity(opened),sha:createHash('sha256').update(text).digest('hex'),text};
    }finally{fs.closeSync(fd);}
}
function selected(){
    const dir=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'opencode');
    for(const basename of ['opencode.jsonc','opencode.json']){
        const logical=path.join(dir,basename);let info;try{info=fs.lstatSync(logical);}catch(e){if(e.code!=='ENOENT')throw e;}
        if(info){const file=fs.realpathSync(logical),found=snapshot(file);if(!found)throw changed();return{logical,file,snapshot:found};}
    }
    const logical=path.join(dir,'opencode.json');return{logical,file:logical,snapshot:null};
}
function origin(value){
    if(typeof value!=='string'||/[\x00-\x20\x7f]/.test(value))throw Error('Некорректный адрес сохранённого моста.');
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.origin!==value||url.username||url.password)throw Error('Некорректный адрес сохранённого моста.');return value;
}
const digest=text=>createHash('sha256').update(text).digest('hex');
const profileState=environment=>path.join(environment.NEUROCENTER_BRIDGE_HOME||path.join((process.platform==='win32'?environment.USERPROFILE:environment.HOME)||os.homedir(),'.config/neurocenter/bridge'),digest(environment.NEUROCENTER_URL).slice(0,20));
const withoutText=value=>{if(value)delete value.text;return value;};
function assertCurrent(expected){
    const current=selected();if(current.snapshot)delete current.snapshot.text;
    if(JSON.stringify(current)!==JSON.stringify(expected))throw changed();
}
/** Publish one checked file; rollback never overwrites a concurrent user edit. */
function replace(file,text,check,mode=0o600,prepared=()=>{}){
    const temporary=path.join(path.dirname(file),'.'+randomUUID()+'.tmp');
    try{
        const fd=fs.openSync(temporary,'wx',mode);
        try{fs.writeFileSync(fd,text);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        prepared(fs.lstatSync(temporary,{bigint:true}));check();fs.renameSync(temporary,file);
        if(process.platform!=='win32'){const directory=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
    }finally{fs.rmSync(temporary,{force:true});}
}
const runtimeEnvironment=(value,target=false)=>({...process.env,...value.saved,...(target?value.target:value.previous)});
function migratedText(root,text,target){
    const {modify,applyEdits}=require(require.resolve('jsonc-parser',{paths:[root]}));
    for(const [key,address]of Object.entries(target))text=applyEdits(text,modify(text,['mcp',name,'environment',key],address,{}));
    if(Buffer.byteLength(text,'utf8')>limit)throw Error('Новые адреса превысят лимит конфигурации OpenCode 8 МиБ. Файлы не заменены.');
    return text;
}
async function configLock(root,file,action){
    const {withGlobalConfigLock}=await import(pathToFileURL(path.join(root,'dist/lib/global-config-lock.js')).href);
    return withGlobalConfigLock(file,action);
}
function assertSkippedPreparation(value){
    if(!value.skipPreparation)return;
    const lock=snapshot(value.skipPreparation.file);
    if(JSON.stringify(withoutText(lock))!==JSON.stringify(value.skipPreparation.snapshot)||value.skipPreparation.pid&&alive(value.skipPreparation.pid))throw Error('Состояние прежнего worker изменилось. Повторите установку.');
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
function workerProof(install,saved){
    try{
        const environment={...process.env,...saved},state=profileState(environment);
        const lock=snapshot(path.join(state,'worker.lock')),marker=snapshot(path.join(state,'worker-version.json')),manifest=snapshot(path.join(install,'package.json')),build=snapshot(path.join(install,'dist/build.json'));
        const pid=Number(lock?.text.trim()),version=JSON.parse(manifest.text),identity=JSON.parse(marker.text),artifact=JSON.parse(build.text),directory=fs.lstatSync(install);
        if(!Number.isSafeInteger(pid)||pid<2||pid===process.pid||!alive(pid)||!directory.isDirectory()||directory.isSymbolicLink()||fs.realpathSync(install)!==install||identity.pid!==pid||identity.version!==version.version||identity.buildId!==artifact.buildId||version.name!==name||!/^[a-f0-9]{64}$/.test(artifact.buildId))return;
        const entry=path.join(install,'dist/index.js'),program=snapshot(entry),node=fs.lstatSync(path.join(install,'bin',nodeName),{bigint:true});if(!program||!node.isFile()||node.nlink!==1n)return;let owned=false;
        if(process.platform==='linux'){
            const argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').replace(/\0$/,'').split('\0');
            owned=fs.statSync('/proc/'+pid).uid===process.getuid()&&argv.at(-2)===entry&&argv.at(-1)==='--worker'&&!argv.slice(1,-2).some(v=>/^(?:--(?:eval|print)(?:=|$)|-[^-]*[ep])/.test(v));
        }else if(process.platform==='win32'){
            const script=`$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; $o=Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; @{owned=($o.ReturnValue -eq 0 -and $o.Sid -eq [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value);command=$p.CommandLine}|ConvertTo-Json -Compress`;
            const result=spawnSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',timeout:5000}),proof=JSON.parse(result.stdout),escaped=entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            owned=result.status===0&&proof.owned===true&&typeof proof.command==='string'&&new RegExp('(?:^|\\s)(?:"'+escaped+'"|'+escaped+')\\s+--worker$').test(proof.command);
        }else{
            const command=spawnSync('ps',['-p',String(pid),'-o','uid=','-o','args='],{encoding:'utf8',timeout:3000}),match=/^(\d+)\s+([\s\S]*)$/.exec(command.stdout.trim()),escaped=entry.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
            owned=command.status===0&&Number(match?.[1])===process.getuid()&&new RegExp('(?:^|\\s)(?:"'+escaped+'"|'+escaped+')\\s+--worker$').test(match[2]);
        }
        if(!owned)return;
        delete manifest.text;delete build.text;delete program.text;return{install,state,pid,directory:{dev:directory.dev,ino:directory.ino},manifest,build,program,node:stamp(node)};
    }catch{return;}// Без доказательства прежнего владельца автоматического запуска нет.
}
exports.main=async([receipt,mode,...args])=>{
    if(mode==='capture'){
        const [packageRoot,install,site,api]=args,current=selected(),target={NEUROCENTER_URL:origin(site),NEUROCENTER_API_URL:origin(api)};let saved={},previous=target,keep=false;
        if(current.snapshot){
            const {parse,parseTree}=require(require.resolve('jsonc-parser',{paths:[packageRoot]})),errors=[],value=parse(current.snapshot.text,errors,{allowTrailingComma:true});
            if(errors.length||!value||typeof value!=='object'||Array.isArray(value)||value.mcp!==undefined&&(!value.mcp||typeof value.mcp!=='object'||Array.isArray(value.mcp)))throw Error('Повреждена конфигурация OpenCode.');
            const tree=parseTree(current.snapshot.text),properties=(tree,key)=>tree?.children?.filter(p=>p.children?.[0]?.value===key)??[];
            const rootMcp=properties(tree,'mcp'),ownProperties=properties(rootMcp[0]?.children?.[1],name),ownTree=ownProperties[0]?.children?.[1];
            const duplicated=tree=>tree?.type==='object'&&new Set(tree.children.map(p=>p.children[0].value)).size!==tree.children.length;
            if(rootMcp.length>1||ownProperties.length>1||duplicated(ownTree)||duplicated(properties(ownTree,'environment')[0]?.children?.[1]))throw Error('Неоднозначная регистрация моста в OpenCode. Удалите повторяющиеся поля.');
            const own=value.mcp?.[name];
            if(own!==undefined){
                if(!own||own.type!=='local'||!Array.isArray(own.command)||JSON.stringify(own.command)!==JSON.stringify([path.join(install,'bin',nodeName),path.join(install,'dist/index.js')])||own.enabled!==undefined&&typeof own.enabled!=='boolean')throw Error('Существующая регистрация моста несовместима с этой папкой установки.');
                saved=own.environment??{};
                if(!saved||typeof saved!=='object'||Array.isArray(saved)||Object.entries(saved).some(([key,v])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof v!=='string'||v.includes('\0')))throw Error('Повреждены сохранённые переменные моста.');
                previous={NEUROCENTER_URL:origin(saved.NEUROCENTER_URL),NEUROCENTER_API_URL:origin(saved.NEUROCENTER_API_URL??saved.NEUROCENTER_URL)};
                for(const key of ['HOME','USERPROFILE','NEUROCENTER_BRIDGE_HOME'])if(Object.hasOwn(saved,key)&&!saved[key])throw Error('Пустая переменная '+key+' в окружении моста.');
                keep=true;
            }
        }
        const migrate=keep&&JSON.stringify(previous)!==JSON.stringify(target),text=migrate?current.snapshot.text:undefined;
        if(migrate)migratedText(packageRoot,text,target);
        if(current.snapshot){delete current.snapshot.text;}
        fs.writeFileSync(receipt,JSON.stringify({current,saved,previous,target,text,keep,migrate,original:workerProof(install,saved)}),{flag:'wx',mode:0o600});process.stdout.write(migrate?'2':keep?'1':'0');return;
    }
    const value=JSON.parse(fs.readFileSync(receipt,'utf8'));
    if(mode==='needs-prepare'){
        const file=path.join(profileState(runtimeEnvironment(value)),'worker.lock'),lock=snapshot(file);let pid;
        if(lock){
            if(!/^[1-9]\d*$/.test(lock.text.trim()))throw Error('Повреждена блокировка прежнего worker.');
            pid=Number(lock.text.trim());if(!Number.isSafeInteger(pid)||pid<2||pid===process.pid)throw Error('Повреждена блокировка прежнего worker.');
            if(alive(pid)){process.stdout.write('1');return;}
        }
        value.skipPreparation={file,snapshot:withoutText(lock),pid};replace(receipt,JSON.stringify(value),()=>{});
        process.stdout.write('0');return;
    }
    if(mode==='assert'){
        assertCurrent(value.current);assertSkippedPreparation(value);return;
    }
    if(mode==='migrate'){
        return configLock(args[0],value.current.file,()=>{
            assertCurrent(value.current);assertSkippedPreparation(value);
            const text=migratedText(args[0],value.text,value.target);
            replace(value.current.file,text,()=>{assertCurrent(value.current);assertSkippedPreparation(value);},Number(value.current.snapshot.stamp.split(':')[5])&0o777,prepared=>{
                value.migration={sha:digest(text),identity:identity(prepared)};
                replace(receipt,JSON.stringify(value),()=>{});
            });
        });
    }
    if(mode==='restore'){
        if(!value.migration)return;
        return configLock(args[0],value.current.file,()=>{
            const current=selected();
            if(current.logical!==value.current.logical||current.file!==value.current.file)throw changed();
            if(current.snapshot?.sha===value.current.snapshot.sha)return;
            if(current.snapshot?.sha!==value.migration.sha||current.snapshot?.identity!==value.migration.identity)throw changed();
            delete current.snapshot.text;
            replace(value.current.file,value.text,()=>assertCurrent(current),Number(value.current.snapshot.stamp.split(':')[5])&0o777);
        });
    }
    if(mode==='restart'){
        const original=value.original;if(!original||alive(original.pid))return;
        const directory=fs.lstatSync(original.install);
        if(directory.dev!==original.directory.dev||directory.ino!==original.directory.ino||!directory.isDirectory()||directory.isSymbolicLink())throw Error('Прежняя папка runtime изменилась; автоматический запуск запрещён.');
        for(const [file,expected] of [[path.join(original.install,'package.json'),original.manifest],[path.join(original.install,'dist/build.json'),original.build],[path.join(original.install,'dist/index.js'),original.program]]){
            const current=snapshot(file);if(current)delete current.text;if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('Прежний runtime изменился; автоматический запуск запрещён.');
        }
        if(stamp(fs.lstatSync(path.join(original.install,'bin',nodeName),{bigint:true}))!==original.node)throw Error('Прежний Node runtime изменился; автоматический запуск запрещён.');
        try{fs.lstatSync(path.join(original.state,'worker.lock'));return;}catch(e){if(e.code!=='ENOENT')throw e;}
        const child=spawn(path.join(original.install,'bin',nodeName),[path.join(original.install,'dist/index.js'),'--worker'],{env:runtimeEnvironment(value),detached:true,stdio:'ignore'});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return;
    }
    if(mode==='run'||mode==='connect'){
        const [node,...cli]=args,result=spawnSync(node,cli,{env:runtimeEnvironment(value,mode==='connect'),stdio:'inherit'});
        if(result.error)throw result.error;if(result.signal)throw Error('Команда моста прервана сигналом '+result.signal);process.exitCode=result.status??1;return;
    }
    throw Error('Неизвестная команда контекста установщика.');
};
