import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import * as contract from '@neurocenter/asset-contract';
import { AssetSourceClient as SourceClient, validateSourcePin as validatePin, type IAssetSourcePin } from '../../../shared/asset-source-client.cjs';
export type { IAssetSourcePin };

/** HTTP-граница не дублирует правила чтения источника, общие с CLI. */
function httpError(error:unknown):never {
    const failure=error as Error&{code?:string};
    if(failure.code==='BAD_SELECTION'){throw new BadRequestException(failure.message);}
    if(['UNAVAILABLE','INVALID_PIN'].includes(failure.code||'')){throw new ServiceUnavailableException(failure.message);}
    throw new ConflictException(failure.message);
}
export function validateSourcePin(value:unknown):IAssetSourcePin {try{return validatePin(value);}catch(error){return httpError(error);}}
export class AssetSourceClient {
    readonly pin:IAssetSourcePin;
    private readonly source:SourceClient;
    constructor(pin:unknown,request:typeof fetch=fetch){this.pin=validateSourcePin(pin);this.source=new SourceClient(this.pin,{contract,fetch:request});}
    async index(){try{return await this.source.index();}catch(error){return httpError(error);}}
    async descriptor(entry:contract.IndexEntry){try{return await this.source.descriptor(entry);}catch(error){return httpError(error);}}
    async select(ids:unknown){try{return await this.source.select(ids);}catch(error){return httpError(error);}}
}
