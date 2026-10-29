import {BadRequestException,ConflictException,ServiceUnavailableException} from '@nestjs/common';
import {assetDigest,validateIndex,toBridgeRelease,type BridgeAsset} from '@neurocenter/asset-contract';
import {AssetSourceClient} from './source-client';
import type {ISourceSnapshot} from './source-snapshots';
import {validBridgeVersion} from './bridge-source-version';

/** Only public GitHub repositories can supply canonical descriptors; installer scripts are never fetched here. */
export function bridgeSourceUrl(value:unknown):string {
    if(typeof value!=='string'||value.length>2048||/[\\\x00-\x20\x7f]/.test(value))throw new BadRequestException('Укажите HTTPS-ссылку на публичный репозиторий поставок моста.');
    try{if(value.split(/[?#]/,1)[0].split('/').slice(3).some(part=>{const decoded=decodeURIComponent(part);return ['.','..'].includes(decoded)||/[\\/]/.test(decoded);}))throw new Error();}
    catch{throw new BadRequestException('Адрес источника моста содержит небезопасный путь.');}
    let url:URL;try{url=new URL(value);}catch{throw new BadRequestException('Укажите ссылку вида https://github.com/owner/repository.');}
    const match=/^\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})\/?$/i.exec(url.pathname);
    if(url.protocol!=='https:'||url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash||!match
        ||['.','..'].includes(match[2]))throw new BadRequestException('Нужна ссылка на корень публичного GitHub-репозитория в формате neurocenter-assets, без токена и install.sh.');
    const repository=match[2].replace(/\.git$/i,'').toLowerCase();
    if(!/^[a-z0-9._-]{1,100}$/.test(repository)||['.','..'].includes(repository))throw new BadRequestException('Некорректное имя репозитория поставок моста.');
    return `https://github.com/${match[1].toLowerCase()}/${repository}`;
}
export const isRetiredBridgeSource=(url:string):boolean=>bridgeSourceUrl(url)==='https://github.com/ghost-raven1/neurocenter-assets';
export const retiredBridgeSourceMessage='Поставка моста приходит с текущей версией приложения. Выберите подготовленный локальный архив; прежние установки и квитанции сохранены.';

async function remote(request:typeof fetch,url:string,maximum:number,signal:AbortSignal):Promise<Buffer>{
    const bounded=AbortSignal.any([signal,AbortSignal.timeout(15000)]);let response:Response;
    try{response=await request(url,{redirect:'error',signal:bounded,headers:{accept:'application/vnd.github+json','User-Agent':'Neurocenter-Bridge-Source'}});}
    catch{throw new ServiceUnavailableException('Источник поставок моста недоступен. Повторите проверку позже.');}
    if(!response.ok||!response.body){await response.body?.cancel();throw new ServiceUnavailableException(response.status===403||response.status===429?'GitHub ограничил запросы. Повторите проверку позже.':'Не удалось прочитать публичный источник поставок моста.');}
    const size=response.headers.get('content-length');
    if(size!==null&&(!/^\d+$/.test(size)||Number(size)>maximum)){await response.body.cancel();throw new ConflictException('Описание источника моста превышает допустимый размер.');}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
    try{for(;;){bounded.throwIfAborted();const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>maximum)throw new ConflictException('Описание источника моста превышает допустимый размер.');chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>undefined);if(error instanceof ConflictException)throw error;throw new ServiceUnavailableException('Передача описания моста прервалась.');}
    finally{reader.releaseLock();}
    if(size!==null&&(!response.headers.get('content-encoding')||response.headers.get('content-encoding')==='identity')&&count!==Number(size))throw new ConflictException('Описание моста передано не полностью.');
    return Buffer.concat(chunks);
}
function json(bytes:Buffer):unknown {try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ConflictException('Источник моста содержит некорректный JSON или UTF-8.');}}

/** One commit and index digest pin only the bridge graph; unrelated asset descriptors are not downloaded. */
export async function readBridgeSource(url:string,signal:AbortSignal,request:typeof fetch=fetch):Promise<ISourceSnapshot>{
    if(isRetiredBridgeSource(url))throw new ConflictException({code:'BRIDGE_SOURCE_ARCHIVE_REQUIRED',sourceReady:false,archiveRequired:true,message:retiredBridgeSourceMessage});
    const repository=bridgeSourceUrl(url).slice('https://github.com/'.length),api='https://api.github.com/repos/'+repository;
    const repo=json(await remote(request,api,64*1024,signal)) as {private?:unknown;default_branch?:unknown};
    if(repo?.private!==false||typeof repo.default_branch!=='string'||!repo.default_branch||repo.default_branch.length>240)throw new ConflictException('Источник должен быть публичным GitHub-репозиторием.');
    const reference=json(await remote(request,api+'/git/ref/heads/'+encodeURIComponent(repo.default_branch),64*1024,signal)) as {ref?:unknown;object?:{type?:unknown;sha?:unknown}};
    const commit=reference?.object?.sha;
    if(reference?.ref!=='refs/heads/'+repo.default_branch||reference?.object?.type!=='commit'||typeof commit!=='string'||!/^[a-f0-9]{40}$/.test(commit))throw new ConflictException('GitHub не подтвердил полный commit источника моста.');
    const bytes=await remote(request,`https://raw.githubusercontent.com/${repository}/${commit}/index.json`,512*1024,signal);
    let index;try{index=validateIndex(json(bytes));}catch{throw new ConflictException('Репозиторий должен содержать index.json в формате neurocenter-assets.');}
    const bridges=index.assets.filter(item=>item.kind==='bridge'&&item.current);
    if(bridges.length!==1)throw new ConflictException(bridges.length?'В источнике несколько текущих мостов. Оставьте одну однозначную поставку.':'В источнике нет текущей поставки моста.');
    const pin={schemaVersion:1 as const,repository,commit,index:{path:'index.json',sha256:assetDigest(bytes)}};
    const selected=await new AssetSourceClient(pin,request,signal).select([bridges[0].id]);
    const bridge=selected.assets.find(item=>item.asset.id===bridges[0].id)!.asset as BridgeAsset;
    const release=toBridgeRelease(bridge);
    if(!validBridgeVersion(release.version))throw new ConflictException('Установщик поддерживает стабильные версии моста вида 1.2.3, без ведущих нулей и слишком больших чисел.');
    signal.throwIfAborted();
    return {pin,index,assets:selected.assets,checked_at:new Date().toISOString()};
}

export function bridgeReleaseView(snapshot:ISourceSnapshot){
    if(snapshot.pin.repository==='ghost-raven1/neurocenter-assets')return undefined;
    const asset=snapshot.assets.find(record=>record.current&&record.asset.kind==='bridge')?.asset as BridgeAsset|undefined;
    if(!asset)return undefined;const release=toBridgeRelease(asset);
    return {assetId:asset.id,version:release.version,buildId:release.buildId,repositoryCommit:snapshot.pin.commit,
        targets:release.artifacts.map(artifact=>String(artifact.metadata.target))};
}
