import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,lstat,chmod,realpath,open,link,rm} from 'node:fs/promises';
import path from 'node:path';
import {ensureModelCredentialKey} from '../workspace/model-credentials.mjs';

/** Явный env-файл Compose имеет приоритет над настройками dev-сессии оператора. */
export function composeEnvironment(source=process.env){
    const environment={...source};
    for(const key of ['PANEL_URL','NEUROCENTER_HOST','NEUROCENTER_RELEASE','SSO_HOST','SSO_CLIENT_ID','REDIRECT_URI','SSO_SCOPE','BOOTSTRAP_ADMIN_EMAIL','BOOTSTRAP_ADMIN_NAME','TLS_CERT_FILE','TLS_KEY_FILE','NEUROCENTER_CONFIG_DIR','COMPOSE_PROFILES','RAG_DEFAULT_QUOTA_BYTES','RAG_MAX_QUOTA_BYTES','BACKUP_MAX_TOTAL_BYTES','BACKUP_MAX_FILE_BYTES','BACKUP_MIN_FREE_BYTES']){delete environment[key];}
    return environment;
}

/** Отдельный production-каталог не наследует локальные .env и пароли стенда. */
export function validateInput(input) {
    const required=name=>{const value=input[name];if(typeof value!=='string'||!value.trim()||/[\x00-\x1f\x7f]/.test(value)){throw new Error('Заполните '+name);}return value.trim();};
    const https=(name,originOnly=false)=>{let url;try{url=new URL(required(name));}catch{throw new Error('Некорректный '+name);}if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||(originOnly&&url.pathname!=='/')){throw new Error(name+': нужен HTTPS URL');}return url;};
    const panel=https('panelUrl',true);const sso=https('ssoHost',true);
    // Значение используется и в nginx server_name: допускается только DNS-имя.
    if(!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(panel.hostname)||panel.port){throw new Error('panelUrl: нужно DNS-имя без нестандартного порта');}
    const email=required('adminEmail').toLowerCase();
    if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)){throw new Error('Некорректная почта первого администратора');}
    const release=required('release');if(!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(release)||release==='latest'){throw new Error('release: укажите постоянную метку версии');}
    const clientId=required('ssoClientId');if(clientId.length>512){throw new Error('Слишком длинный ssoClientId');}
    const adminName=input.adminName?.trim()||'Главный администратор';
    if(adminName.length>128||/[\x00-\x1f\x7f]/.test(adminName)){throw new Error('Некорректное имя администратора');}
    const ragDefaultQuotaBytes=input.ragDefaultQuotaBytes===undefined?1024**3:input.ragDefaultQuotaBytes;const ragMaxQuotaBytes=input.ragMaxQuotaBytes===undefined?16*1024**3:input.ragMaxQuotaBytes;
    if(![ragDefaultQuotaBytes,ragMaxQuotaBytes].every(value=>Number.isSafeInteger(value)&&value>0)||ragDefaultQuotaBytes>ragMaxQuotaBytes){throw new Error('Укажите положительные целые лимиты RAG; значение по умолчанию не больше максимума');}
    const backupMaxTotalBytes=input.backupMaxTotalBytes===undefined?64*1024**3:input.backupMaxTotalBytes;
    const backupMaxFileBytes=input.backupMaxFileBytes===undefined?16*1024**3:input.backupMaxFileBytes;
    const backupMinFreeBytes=input.backupMinFreeBytes===undefined?1024**3:input.backupMinFreeBytes;
    if(![backupMaxTotalBytes,backupMaxFileBytes,backupMinFreeBytes].every(value=>Number.isSafeInteger(value)&&value>0)||backupMaxFileBytes>backupMaxTotalBytes){throw new Error('Укажите положительные целые лимиты копий; размер файла не больше общего бюджета');}
    return {panelUrl:panel.origin,ssoHost:sso.origin,host:panel.hostname,clientId,email,adminName,release,ragDefaultQuotaBytes,ragMaxQuotaBytes,backupMaxTotalBytes,backupMaxFileBytes,backupMinFreeBytes,
        tlsCertFile:path.resolve(required('tlsCertFile')),tlsKeyFile:path.resolve(required('tlsKeyFile'))};
}

async function safeFile(filename) {
    try{const info=await lstat(filename);if(!info.isFile()||info.nlink!==1){throw new Error('Нужен отдельный обычный файл: '+path.basename(filename));}return true;}
    catch(error){if(error.code==='ENOENT'){return false;}throw error;}
}

/** Атомарная запись с закрытыми правами; не следует по ссылкам. */
async function privateWrite(filename,value) {
    await safeFile(filename);const temporary=filename+'.'+randomBytes(8).toString('hex')+'.tmp';
    await writeFile(temporary,value,{mode:0o600,flag:'wx'});await rename(temporary,filename);
}

/** Дополняет прежний приватный конфиг отдельным ключом сборщика без ротации рабочих секретов. */
export async function ensureMetricsToken(directory) {
    for(const folder of [directory,path.join(directory,'secrets')]){
        const info=await lstat(folder);
        if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077){throw new Error('Для метрик нужен закрытый каталог production-конфига');}
    }
    const filename=path.join(directory,'secrets/metrics_token');
    if(!await safeFile(filename)){
        const temporary=filename+'.'+randomBytes(8).toString('hex')+'.tmp';
        try{
            await writeFile(temporary,randomBytes(32).toString('hex')+'\n',{mode:0o600,flag:'wx',flush:true});
            try{await link(temporary,filename);}catch(error){if(error.code!=='EEXIST'){throw error;}}
        }finally{await rm(temporary,{force:true});}
        const handle=await open(path.dirname(filename),'r');try{await handle.sync();}finally{await handle.close();}
    }
    if(!await safeFile(filename)||!/^[a-f0-9]{64}$/.test((await readFile(filename,'utf8')).trim())){throw new Error('Некорректный секрет метрик; автоматическая замена запрещена');}
    await chmod(filename,0o600);
}

export async function configureProduction(input,destination) {
    const config=validateInput(input);await mkdir(destination,{recursive:true,mode:0o700});
    const info=await lstat(destination);if(!info.isDirectory()||info.isSymbolicLink()){throw new Error('Каталог настройки не должен быть ссылкой');}
    const directory=await realpath(destination);await chmod(directory,0o700);
    const secrets=path.join(directory,'secrets');await mkdir(secrets,{recursive:true,mode:0o700});
    const secretInfo=await lstat(secrets);if(!secretInfo.isDirectory()||secretInfo.isSymbolicLink()){throw new Error('Каталог секретов не должен быть ссылкой');}await chmod(secrets,0o700);
    const secret=async(name,generate)=>{const filename=path.join(secrets,name);if(await safeFile(filename)){await chmod(filename,0o600);return (await readFile(filename,'utf8')).trim();}const value=generate();await privateWrite(filename,value+'\n');return value;};
    await secret('postgres_password',()=>randomBytes(32).toString('hex'));
    await secret('internal_token',()=>randomBytes(32).toString('hex'));
    await ensureMetricsToken(directory);
    await ensureModelCredentialKey(directory);
    for(const [name,role,database] of [['catalog_url','nc_catalog','catalog'],['rag_url','nc_rag','rag'],['rag_provision_url','nc_provisioner','postgres'],['backup_url','nc_backup','rag']]){
        await secret(name,()=>`postgresql://${role}:${randomBytes(32).toString('hex')}@postgres:5432/${database}`);
    }
    if(input.ssoClientSecret!==undefined){
        if(typeof input.ssoClientSecret!=='string'||!input.ssoClientSecret.trim()||/[\x00\r\n]/.test(input.ssoClientSecret)){throw new Error('Заполните ssoClientSecret');}
        await privateWrite(path.join(secrets,'sso_client_secret'),input.ssoClientSecret+'\n');
    }else if(!await safeFile(path.join(secrets,'sso_client_secret'))){throw new Error('Заполните ssoClientSecret');}
    const values={NEUROCENTER_CONFIG_DIR:directory,NEUROCENTER_RELEASE:config.release,PANEL_URL:config.panelUrl,NEUROCENTER_HOST:config.host,RAG_DEFAULT_QUOTA_BYTES:String(config.ragDefaultQuotaBytes),RAG_MAX_QUOTA_BYTES:String(config.ragMaxQuotaBytes),
        BACKUP_MAX_TOTAL_BYTES:String(config.backupMaxTotalBytes),BACKUP_MAX_FILE_BYTES:String(config.backupMaxFileBytes),BACKUP_MIN_FREE_BYTES:String(config.backupMinFreeBytes),
        SSO_HOST:config.ssoHost,SSO_CLIENT_ID:config.clientId,REDIRECT_URI:config.panelUrl+'/auth/callback',SSO_SCOPE:'openid profile email',
        BOOTSTRAP_ADMIN_EMAIL:config.email,BOOTSTRAP_ADMIN_NAME:config.adminName,TLS_CERT_FILE:config.tlsCertFile,TLS_KEY_FILE:config.tlsKeyFile};
    const quoted=value=>"'"+value.replace(/'/g,"\\'")+"'";
    await privateWrite(path.join(directory,'.env'),Object.entries(values).map(([key,value])=>key+'='+quoted(value)).join('\n')+'\n');
    return {directory,config};
}
