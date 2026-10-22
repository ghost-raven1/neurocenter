import {compareBridgeVersions} from './bridgeSource';

export interface IBridgeArchiveSupply {version:string;buildId:string;targets:string[];}
export interface IBridgeArchiveRequest {origin:string;version:string;buildId:string;target:string;file:string;}
export interface IBridgeArchive extends IBridgeArchiveRequest {sha256:string;bytes:number;}
const targetPattern=/^(?:(?:darwin|windows)-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?)$/;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** A full target is chosen explicitly; browser architecture and Linux libc are never guessed. */
export function bridgeArchiveTargets(supply:IBridgeArchiveSupply|undefined):string[] {
    if(!supply||typeof supply.version!=='string'||typeof supply.buildId!=='string'||compareBridgeVersions(supply.version,supply.version)!==0||!/^[a-f0-9]{64}$/.test(supply.buildId)
        ||!Array.isArray(supply.targets)||!supply.targets.length||supply.targets.length>8
        ||supply.targets.some(target=>typeof target!=='string'||!targetPattern.test(target))||new Set(supply.targets).size!==supply.targets.length)return[];
    return supply.targets;
}

export function bridgeArchiveRequest(origin:string,supply:IBridgeArchiveSupply,target:string):IBridgeArchiveRequest {
    const url=new URL(origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==origin||!bridgeArchiveTargets(supply).includes(target))throw Error('Выберите доступную систему из проверенной поставки.');
    return{origin,version:supply.version,buildId:supply.buildId,target,file:`neurocenter-asset-sync-${target}-${supply.version}.tgz`};
}

/** Only metadata matching the selected generation may expose its download links. */
export function readBridgeArchive(value:unknown,expected:IBridgeArchiveRequest):IBridgeArchive {
    if(!object(value)||value.version!==expected.version||value.buildId!==expected.buildId||value.target!==expected.target
        ||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||Number(value.bytes)<=0||Number(value.bytes)>1024**3)throw Error('Метаданные архива не совпали с выбранной поставкой. Обновите список и повторите.');
    return{...expected,sha256:value.sha256,bytes:Number(value.bytes)};
}

/** Literal local paths are quoted as a single argument; no upload, glob or network command is generated. */
export function localBridgeArchiveCommand(archive:string,windows:boolean):string {
    if(!archive.trim()||archive.length>4096||/[\x00-\x1f\x7f]/.test(archive))throw Error('Укажите имя или путь к локальному архиву без переводов строки.');
    const quoted="'"+archive.replace(/'/g,windows?"''":"'\"'\"'")+"'";
    return windows?`& .\\install.ps1 -Archive ${quoted}`:`bash ./install.sh --archive ${quoted}`;
}
