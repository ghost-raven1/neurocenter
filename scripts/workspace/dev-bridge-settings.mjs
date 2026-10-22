import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const missing=error=>error.code==='ENOENT';
export const bridgeEntryName='neurocenter-asset-sync';

/** Snapshots are also rollback receipts: a later user edit must never be overwritten. */
export async function bridgeFileSnapshot(file){
    try{
        const info=await fs.lstat(file);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>8*1024**2)throw Error('Небезопасный файл настроек моста: '+file);
        const bytes=await fs.readFile(file),after=await fs.lstat(file);
        if(info.ino!==after.ino||info.dev!==after.dev||info.mtimeMs!==after.mtimeMs||info.size!==after.size)throw Error('Настройки изменились при чтении: '+file);
        return{file,bytes,mode:info.mode&0o777,ino:info.ino,dev:info.dev,sha256:digest(bytes)};
    }catch(error){if(missing(error))return{file,bytes:null};throw error;}
}
export async function assertBridgeSnapshot(snapshot){
    const current=await bridgeFileSnapshot(snapshot.file);
    if(current.sha256!==snapshot.sha256||current.ino!==snapshot.ino||current.dev!==snapshot.dev)throw Error('Настройки изменены другим процессом: '+snapshot.file);
}
export async function writeBridgeFile(file,bytes,mode=0o600,expected){
    const temporary=path.join(path.dirname(file),'.neurocenter-dev-'+randomUUID()+'.tmp');
    try{
        const handle=await fs.open(temporary,'wx',mode);
        try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        if(expected)await assertBridgeSnapshot(expected);
        await fs.rename(temporary,file);
    }finally{await fs.rm(temporary,{force:true});}
}
export async function restoreBridgeFile(original,expected){
    await assertBridgeSnapshot(expected);
    if(original.bytes===null)await fs.unlink(original.file);
    else await writeBridgeFile(original.file,original.bytes,original.mode,expected);
}
export function bridgeOrigin(value){
    if(typeof value!=='string'||value.length>2048||/[\x00-\x20\x7f]/.test(value))throw Error('Не сохранён корректный адрес площадки моста.');
    const url=new URL(value);
    if(!['https:','http:'].includes(url.protocol)||url.origin!==value||url.username||url.password)throw Error('Адрес моста должен быть HTTP(S) origin.');
    return value;
}
function parseConfiguration(bytes,jsonc){
    const errors=[],value=jsonc.parse(bytes.toString('utf8'),errors,{allowTrailingComma:true});
    if(errors.length||!value||typeof value!=='object'||Array.isArray(value)||value.mcp!==undefined&&(!value.mcp||typeof value.mcp!=='object'||Array.isArray(value.mcp)))throw Error('Повреждён JSON/JSONC конфигурации OpenCode.');
    return value;
}
export async function selectedBridgeConfig(home,environment){
    const directory=path.join(environment.XDG_CONFIG_HOME||path.join(home,'.config'),'opencode');
    for(const name of ['opencode.jsonc','opencode.json']){
        const file=path.join(directory,name);
        try{return{logical:file,snapshot:await bridgeFileSnapshot(await fs.realpath(file))};}
        catch(error){if(!missing(error))throw error;}
    }
    const logical=path.join(directory,'opencode.json');return{logical,snapshot:await bridgeFileSnapshot(logical)};
}
/** Saved installation identity wins over a caller's current dev URLs; conflicting saved identities fail closed. */
export async function installedBridgeSettings({install,home,environment,jsonc}){
    const config=await selectedBridgeConfig(home,environment),original=config.snapshot;
    const own=original.bytes===null?undefined:parseConfiguration(original.bytes,jsonc).mcp?.[bridgeEntryName];
    if(own!==undefined&&(!own||typeof own!=='object'||Array.isArray(own)))throw Error('Повреждена запись моста в OpenCode.');
    const savedEnvironment=own?.environment??{};
    if(!savedEnvironment||typeof savedEnvironment!=='object'||Array.isArray(savedEnvironment)||Object.values(savedEnvironment).some(value=>typeof value!=='string'))throw Error('Повреждены переменные моста в OpenCode.');
    const marker=await bridgeFileSnapshot(path.join(install,'installation.json'));let siteUrl,apiUrl;
    if(marker.bytes!==null){
        const saved=JSON.parse(marker.bytes);if(saved.schemaVersion!==1)throw Error('Неизвестная версия installation.json.');
        siteUrl=bridgeOrigin(saved.siteUrl);apiUrl=bridgeOrigin(saved.apiUrl);
        if(savedEnvironment.NEUROCENTER_URL&&bridgeOrigin(savedEnvironment.NEUROCENTER_URL)!==siteUrl||savedEnvironment.NEUROCENTER_API_URL&&bridgeOrigin(savedEnvironment.NEUROCENTER_API_URL)!==apiUrl)throw Error('Сохранённые адреса моста и OpenCode расходятся; автоматическая смена площадки запрещена.');
    }else{
        siteUrl=bridgeOrigin(savedEnvironment.NEUROCENTER_URL);apiUrl=bridgeOrigin(savedEnvironment.NEUROCENTER_API_URL||siteUrl);
    }
    return{config,own,marker,siteUrl,apiUrl,environment:{...environment,...savedEnvironment,NEUROCENTER_URL:siteUrl,NEUROCENTER_API_URL:apiUrl}};
}
/** --init owns registration; this final JSONC edit retains the previous entry's explicit settings. */
export function expectedBridgeRegistration(settings,jsonc,install){
    const entry={type:'local',enabled:true,command:[path.join(install,'bin',process.platform==='win32'?'node.exe':'node'),path.join(install,'dist/index.js')],environment:{NEUROCENTER_URL:settings.siteUrl,...(settings.apiUrl===settings.siteUrl?{}:{NEUROCENTER_API_URL:settings.apiUrl})}};
    const text=settings.config.snapshot.bytes?.toString('utf8')??'{}\n';
    return jsonc.applyEdits(text,jsonc.modify(text,['mcp',bridgeEntryName],entry,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));
}
export function expectedBridgeLauncher(install){
    const windows=process.platform==='win32',node=path.join(install,'bin',windows?'node.exe':'node'),entry=path.join(install,'dist/bridge-cli.js');
    const quote=value=>"'"+value.replace(/'/g,"'\"'\"'")+"'",escape=value=>value.replace(/%/g,'%%');
    return windows?`@echo off\r\nsetlocal DisableDelayedExpansion\r\nrem Neurocenter bridge command v1\r\nif not exist "${escape(node)}" goto missing\r\nif not exist "${escape(entry)}" goto missing\r\n"${escape(node)}" "${escape(entry)}" %*\r\nexit /b %errorlevel%\r\n:missing\r\necho Bridge missing. Reinstall from Neurocenter Start page. 1>&2\r\nexit /b 1\r\n`
        :`#!/bin/sh\n# Neurocenter bridge command v1\nif [ ! -x ${quote(node)} ] || [ ! -f ${quote(entry)} ]; then\n  printf '%s\\n' 'Мост не найден или повреждён. Повторите установку на странице «Начало работы».' >&2\n  exit 1\nfi\nexec ${quote(node)} ${quote(entry)} "$@"\n`;
}
export async function retainBridgeSettings({settings,home,environment,jsonc,withConfigLock,install,expected}){
    const selected=await selectedBridgeConfig(home,environment);
    if(selected.logical!==settings.config.logical||selected.snapshot.file!==settings.config.snapshot.file)throw Error('Путь OpenCode изменился во время обновления.');
    return withConfigLock(selected.snapshot.file,async()=>{
        const locked=await selectedBridgeConfig(home,environment);
        if(locked.logical!==selected.logical||locked.snapshot.file!==selected.snapshot.file)throw Error('Путь OpenCode изменился во время блокировки.');
        await assertBridgeSnapshot(expected);
        const current=await bridgeFileSnapshot(selected.snapshot.file);
        if(current.bytes===null)throw Error('OpenCode не подтвердил регистрацию моста.');
        const value=parseConfiguration(current.bytes,jsonc),entry=value.mcp?.[bridgeEntryName];
        const command=[path.join(install,'bin',process.platform==='win32'?'node.exe':'node'),path.join(install,'dist/index.js')];
        if(entry?.type!=='local'||JSON.stringify(entry.command)!==JSON.stringify(command))throw Error('Регистрация моста не совпала с установленной программой.');
        const preserved={...settings.own,...entry,environment:{...settings.own?.environment,...entry.environment,NEUROCENTER_URL:settings.siteUrl,...(settings.apiUrl===settings.siteUrl?{}:{NEUROCENTER_API_URL:settings.apiUrl})}};
        if(typeof settings.own?.enabled==='boolean')preserved.enabled=settings.own.enabled;
        const text=jsonc.applyEdits(current.bytes.toString('utf8'),jsonc.modify(current.bytes.toString('utf8'),['mcp',bridgeEntryName],preserved,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));
        if(text!==current.bytes.toString('utf8')){
            const latest=await selectedBridgeConfig(home,environment);
            if(latest.logical!==selected.logical||latest.snapshot.file!==selected.snapshot.file)throw Error('Путь OpenCode изменился перед записью.');
            await writeBridgeFile(current.file,text,current.mode,current);
        }
        return bridgeFileSnapshot(current.file);
    });
}
