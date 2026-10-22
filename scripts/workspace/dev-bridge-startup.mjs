import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {bridgeRuntimeCached} from '../bridge-runtime-artifacts.mjs';
import {verifyBridgeBuild} from '../bridge-build-integrity.mjs';
import {assertBridgeSnapshot,bridgeFileSnapshot} from './dev-bridge-settings.mjs';
import {devBridgeTarget} from './dev-bridge-runtime.mjs';
import {updateInstalledDevBridge} from './dev-bridge-install.mjs';

/** The desired generation is read only after the local servers are ready; no new package is built here. */
async function publishedSupply(root){
    const checkout=await fs.realpath(root),directory=path.join(checkout,'.run/dev-bridge/runtime');
    let info;try{info=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(directory)!==directory)throw Error('Каталог dev-поставки должен находиться в checkout без ссылок.');
    const pointer=await bridgeFileSnapshot(path.join(directory,'current.json'));if(pointer.bytes===null)return;
    if(pointer.bytes.length>65536)throw Error('Метаданные dev-поставки слишком велики.');
    const value=JSON.parse(pointer.bytes);
    if(!value||typeof value.version!=='string'||typeof value.buildId!=='string'||typeof value.sourceCommit!=='string'||!/^\d+\.\d+\.\d+$/.test(value.version)||!/^[a-f0-9]{64}$/.test(value.buildId)||!/^[a-f0-9]{40}$/.test(value.sourceCommit)||value.target!==devBridgeTarget()||typeof value.directory!=='string'||!/^generation-[\w-]+$/.test(value.directory))throw Error('Некорректная версия, платформа или каталог dev-поставки.');
    const generation=path.join(directory,value.directory),generationInfo=await fs.lstat(generation);
    if(!generationInfo.isDirectory()||generationInfo.isSymbolicLink()||await fs.realpath(generation)!==generation)throw Error('Каталог поколения dev-моста заменён ссылкой.');
    const archive=path.join(generation,`neurocenter-asset-sync-${value.target}-${value.version}.tgz`),metadataSnapshot=await bridgeFileSnapshot(archive+'.json');
    if(!metadataSnapshot.bytes||metadataSnapshot.bytes.length>65536)throw Error('Не сохранены метаданные архива dev-моста.');
    const metadata=JSON.parse(metadataSnapshot.bytes);
    if(!Number.isSafeInteger(metadata.bytes)||metadata.bytes<=0||metadata.bytes>1024**3)throw Error('Размер dev-архива превышает допустимый предел 1 ГиБ.');
    if(!await bridgeRuntimeCached({...value,directory:generation,metadata}))throw Error('Dev-поставка не прошла проверку архива, SHA и метаданных. Повторите scripts/dev.sh install.');
    const checkoutDist=path.join(checkout,'mcp/neurocenter-asset-sync/dist'),checkoutInfo=await fs.lstat(checkoutDist).catch(error=>{if(error.code==='ENOENT')throw Error('Текущая сборка MCP отсутствует. Повторите scripts/dev.sh install.');throw error;});
    if(!checkoutInfo.isDirectory()||checkoutInfo.isSymbolicLink()||await fs.realpath(checkoutDist)!==checkoutDist)throw Error('Текущая сборка MCP недоступна без ссылок. Повторите scripts/dev.sh install.');
    const currentBuild=await verifyBridgeBuild(checkoutDist,value.version);
    if(currentBuild.buildId!==value.buildId)throw Error('Dev-поставка старее текущей сборки MCP. Повторите scripts/dev.sh install, затем scripts/dev.sh up.');
    await assertBridgeSnapshot(metadataSnapshot);await assertBridgeSnapshot(pointer);
    return{root:checkout,archive,sha256:metadata.sha256,version:value.version,buildId:value.buildId,target:value.target,pointer};
}
async function alreadyCurrent(install,supply){
    let info;try{info=await fs.lstat(install);}catch(error){if(error.code==='ENOENT')return false;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(install)!==install)throw Error('Папка установленного моста должна быть обычным каталогом без ссылок.');
    const receipt=await bridgeFileSnapshot(path.join(install,'.neurocenter-dev-supply.json'));if(receipt.bytes===null)return false;
    if(receipt.bytes.length>65536)throw Error('Метка установленной dev-поставки слишком велика.');
    const saved=JSON.parse(receipt.bytes);
    if(saved.schemaVersion!==1||typeof saved.version!=='string'||typeof saved.buildId!=='string'||typeof saved.sha256!=='string'||!/^\d+\.\d+\.\d+$/.test(saved.version)||!/^[a-f0-9]{64}$/.test(saved.buildId)||!/^[a-f0-9]{64}$/.test(saved.sha256)||saved.target!==devBridgeTarget())throw Error('Повреждена метка установленной dev-поставки.');
    if(saved.version!==supply.version||saved.buildId!==supply.buildId||saved.sha256!==supply.sha256)return false;
    const dist=path.join(install,'dist'),distInfo=await fs.lstat(dist);
    if(!distInfo.isDirectory()||distInfo.isSymbolicLink()||await fs.realpath(dist)!==dist)throw Error('Каталог установленной сборки MCP заменён ссылкой.');
    const manifest=await bridgeFileSnapshot(path.join(install,'package.json')),build=await bridgeFileSnapshot(path.join(install,'dist/build.json')),runtime=await bridgeFileSnapshot(path.join(install,'runtime.json'));
    if(!manifest.bytes||!build.bytes||!runtime.bytes)throw Error('Метаданные установленного dev-моста потеряны.');
    const metadata=JSON.parse(manifest.bytes),artifact=JSON.parse(build.bytes),host=JSON.parse(runtime.bytes);
    if(metadata.name!=='neurocenter-asset-sync'||metadata.version!==supply.version||artifact.buildId!==supply.buildId||host.version!==supply.version||host.buildId!==supply.buildId||host.target!==supply.target||typeof host.nodeVersion!=='string'||!/^24\./.test(host.nodeVersion))throw Error('Метаданные установленного dev-моста изменились.');
    return(await verifyBridgeBuild(path.join(install,'dist'),supply.version)).buildId===supply.buildId;
}
/** Optional migration never takes down healthy services; a retained pointer retries the same transaction on the next up. */
export async function applyPublishedDevBridge({root,environment=process.env,output,node=process.execPath},dependencies={}){
    try{
        const supply=await publishedSupply(root);if(!supply)return{updated:false,reason:'no-supply'};
        const home=environment.HOME||environment.USERPROFILE||os.homedir(),install=path.resolve(environment.INSTALL_DIR||path.join(home,'.opencode/neurocenter-asset-sync'));
        if(await alreadyCurrent(install,supply)){
            await assertBridgeSnapshot(supply.pointer);
            output?.info?.('Установленный мост','Текущая dev-сборка уже установлена.');
            return{updated:false,reason:'already-current',version:supply.version,buildId:supply.buildId};
        }
        await assertBridgeSnapshot(supply.pointer);
        return await(dependencies.updateInstalled??updateInstalledDevBridge)({...supply,environment,output,node});
    }catch(error){
        output?.warning?.('Обновление установленного моста отложено: '+error.message+' Сервисы продолжают работать. Повторите scripts/dev.sh up после устранения причины.');
        return{updated:false,reason:'update-deferred'};
    }
}
