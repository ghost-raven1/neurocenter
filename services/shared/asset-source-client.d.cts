import type {AssetIndex,IndexEntry,ResolvedAsset} from '@neurocenter/asset-contract';
export interface IAssetSourcePin {schemaVersion:1;repository:string;commit:string;index:{path:string;sha256:string}}
export function validateSourcePin(value:unknown):IAssetSourcePin;
export class AssetSourceClient {
    readonly pin:IAssetSourcePin;
    constructor(pin:unknown,options:{contract:typeof import('@neurocenter/asset-contract');fetch?:typeof fetch;signal?:AbortSignal;offline?:boolean;
        cache?:{read(sha:string,maximum:number):Promise<Uint8Array|undefined>;write?(sha:string,bytes:Uint8Array):Promise<void>}});
    index():Promise<AssetIndex>;
    descriptor(entry:IndexEntry):Promise<ResolvedAsset>;
    select(ids:unknown):Promise<{index:AssetIndex;assets:ResolvedAsset[]}>;
}
