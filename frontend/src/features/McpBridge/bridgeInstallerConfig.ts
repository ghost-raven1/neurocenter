import {compareBridgeVersions} from './bridgeSource';

export interface IBridgeDevSupply {
    version:string;
    buildId:string;
    targets:string[];
}
export interface IBridgeInstallerConfig {
    origin:string;
    devSupply?:IBridgeDevSupply;
}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const target=/^(?:(?:darwin|windows)-(?:arm64|x64)|linux-(?:arm64|x64)(?:-musl)?)$/;

/** Malformed dev metadata invalidates the whole response; it cannot silently select the catalog installer. */
export function readBridgeInstallerConfig(value:unknown):IBridgeInstallerConfig {
    if(!object(value)||typeof value.origin!=='string')throw new Error('Gateway не сообщил адрес установщика.');
    const url=new URL(value.origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==value.origin)throw new Error('Gateway сообщил некорректный адрес установщика.');
    if(!Object.prototype.hasOwnProperty.call(value,'devSupply'))return{origin:url.origin};
    const supply=value.devSupply;
    if(!object(supply)||typeof supply.version!=='string'||compareBridgeVersions(supply.version,supply.version)!==0
        ||typeof supply.buildId!=='string'||!/^[a-f0-9]{64}$/.test(supply.buildId)
        ||!Array.isArray(supply.targets)||supply.targets.length===0
        ||!supply.targets.every((value):value is string=>typeof value==='string'&&target.test(value))
        ||new Set(supply.targets).size!==supply.targets.length)throw new Error('Gateway сообщил некорректную dev-поставку моста.');
    return{origin:url.origin,devSupply:{version:supply.version,buildId:supply.buildId,targets:[...supply.targets]}};
}
