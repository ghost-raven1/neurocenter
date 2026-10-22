const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const [root,site,api,reconnect]=process.argv.slice(2),stage=__dirname,receipt=path.join(stage,'profile.json');
const node=path.join(root,'bin',process.platform==='win32'?'node.exe':'node'),entry=path.join(root,'dist/index.js');
const context=path.join(stage,'context.cjs'),lock=root+'.install-lock';
const retained=path.join(stage,'retain');
let locked=false,attempted=false,prepared=false,registered=false;
const clean=value=>String(value).replace(/[\x00-\x1f\x7f-\x9f]/g,' ');
function call(mode,...args){
    const bootstrap="require(process.argv[1]).main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;})";
    const result=spawnSync(node,['-e',bootstrap,context,receipt,mode,...args],{env:process.env,encoding:'utf8',timeout:95000,maxBuffer:1024*1024});
    if(result.error||result.signal||result.status!==0){
        let message;try{message=JSON.parse(result.stdout).error;}catch{}
        throw Error(typeof message==='string'?clean(message):clean(result.stderr?.trim()||'Команда моста не завершена. Проверьте соединение и повторите подключение.'));
    }
    return result.stdout;
}
function finish(){
    if(!prepared)return;
    const value=JSON.parse(call('run',node,entry,'--finish-upgrade'));
    if(value.ok!==true)throw Error('Снятие паузы прежнего подключения не подтверждено.');
    prepared=false;
}
function output(value){
    if(value.connected===true){console.log('✓ Компьютер подключён к Нейроцентру. Существующее подключение сохранено.');return;}
    if(typeof value.url!=='string'||new URL(value.url).origin!==site||typeof value.code!=='string')throw Error('Мост не подтвердил адрес подключения. Повторите команду после проверки сервера.');
    console.log('Компьютер ожидает подтверждения.');
    console.log(value.browserOpened?'Страница подключения открыта в браузере.':'Откройте страницу подключения:');
    console.log(clean(value.url)+'\nКод: '+clean(value.code));
    if(value.fingerprint)console.log('Отпечаток: '+clean(value.fingerprint));
}
try{
    if(!path.isAbsolute(root)||fs.lstatSync(root).isSymbolicLink())throw Error('Укажите настоящий каталог установленного моста через INSTALL_DIR.');
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    if(manifest.name!=='neurocenter-asset-sync')throw Error('В указанном каталоге находится другая программа. Укажите INSTALL_DIR моста.');
    fs.mkdirSync(lock,{mode:0o700});locked=true;fs.writeFileSync(path.join(lock,'owner.pid'),String(process.pid),{mode:0o600,flag:'wx'});
    const keep=call('capture',root,root,site,api);
    if(!['0','1','2'].includes(keep))throw Error('Не удалось проверить регистрацию установленного моста.');
    if(keep==='0'||keep==='2'&&!fs.existsSync(path.join(root,'dist/lib/global-config-lock.js'))){process.exitCode=42;}
    else{
        if(keep==='2'){
            if(call('needs-prepare')==='1'){
                attempted=true;prepared=true;
                const result=JSON.parse(call('run',node,entry,'--prepare-upgrade',entry));
                if(result.ok!==true||typeof result.paused!=='boolean')throw Error('Предыдущий мост не подтвердил подготовку перехода.');
                prepared=result.paused;if(!prepared)attempted=false;
            }
            call('assert');finish();
            fs.writeFileSync(retained,'registration migration in progress',{mode:0o600,flag:'wx'});
            call('migrate',root);
        }else call('assert');
        registered=true;
        try{fs.rmSync(retained,{force:true});}catch{console.error('Приватный снимок сохранён: '+stage);}
        // Launcher repair is optional: older bundles can connect directly through their index CLI.
        if(fs.existsSync(path.join(root,'dist/bridge-cli.js'))){
            const command=spawnSync(node,[path.join(root,'dist/bridge-cli.js'),'--install-command'],{env:{...process.env,NEUROCENTER_URL:site,NEUROCENTER_API_URL:api},encoding:'utf8',timeout:15000,maxBuffer:65536});
            if(command.error||command.signal||command.status!==0)console.error('Короткую команду обновить не удалось; подключение продолжится через установленный мост.');
        }
        output(JSON.parse(call('connect',node,entry,reconnect==='1'?'--reconnect-open':'--connect-open')));
        console.log('После подтверждения нажмите «Проверить подключение» на сайте.');
    }
}catch(error){console.error(clean(error.message));process.exitCode=1;}
finally{
    if(!registered&&fs.existsSync(receipt)){
        try{call('restore',root);fs.rmSync(retained,{force:true});}catch{
            console.error('Восстановление регистрации не подтверждено. Приватный снимок сохранён: '+stage);
        }
    }
    let resumed=true;try{finish();}catch{resumed=false;console.error('Снятие паузы не подтверждено. Повторите подключение после восстановления связи.');process.exitCode=1;}
    if(!registered&&attempted&&resumed){try{call('restart');}catch{console.error('Запуск прежнего worker не подтверждён. Перезапустите OpenCode.');}}
    if(locked){fs.unlinkSync(path.join(lock,'owner.pid'));fs.rmdirSync(lock);}
}
