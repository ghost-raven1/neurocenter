import type {AdapterParameters} from '../../../../services/shared/adapter-parameters.cjs';

/** The editor retains arbitrary private JSON; authoritative adapter/path validation stays on the server. */
export function parseProviderParameters(value:string):AdapterParameters|undefined {
    if(!value.trim())return undefined;
    if(new TextEncoder().encode(value).byteLength>65536)throw Error('Параметры адаптера превышают 64 КиБ.');
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw Error('Исправьте JSON параметров адаптера.');}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('Параметры адаптера должны быть JSON-объектом.');
    return parsed as AdapterParameters;
}
