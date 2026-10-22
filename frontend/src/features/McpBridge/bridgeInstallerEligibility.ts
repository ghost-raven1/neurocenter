import type {IBridgeDevSupply} from './bridgeInstallerConfig';

/** Known reports require an exact package; an unknown architecture permits only the matching script family. */
export function bridgeInstallerEligibility(supply:IBridgeDevSupply|undefined,windows:boolean,target?:string):{supported:boolean;confirmed:boolean} {
    if(!supply)return{supported:true,confirmed:false};
    const family=(value:string)=>windows?value.startsWith('windows-'):value.startsWith('darwin-')||value.startsWith('linux-');
    const supported=target?supply.targets.includes(target)&&family(target):supply.targets.some(family);
    return{supported,confirmed:supported&&!!target};
}
