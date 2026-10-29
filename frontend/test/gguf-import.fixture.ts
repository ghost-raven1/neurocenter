import {vi} from 'vitest';
import {DEFAULT_GGUF_IMPORT_POLICY} from '../../services/shared/gguf-import-policy.cjs';
import type {GgufImportReceipt} from '../src/features/GgufImport/model';
import type {GgufImportApi} from '../src/features/GgufImport/api';
export const key='22222222-2222-4222-8222-222222222222',id='11111111-1111-4111-8111-111111111111';
export const policy={...DEFAULT_GGUF_IMPORT_POLICY,maximumBytes:1000};
export const receipt=(state:GgufImportReceipt['state']='WAITING'):GgufImportReceipt=>({id,requestKey:key,fileName:'owned.gguf',bytes:4,state,sha256:['READY','ACCEPTED'].includes(state)?'a'.repeat(64):null,metadata:['READY','ACCEPTED'].includes(state)?{format:'gguf',version:3,architecture:'llama',tensorCount:1,metadataCount:1}:null,modelId:state==='ACCEPTED'?'model-gguf-'+id:null,expiresAt:'2099-10-29T12:00:00Z',limits:policy});
export const imported=()=>({id:'model-gguf-'+id,name:'Owned model',description:'',capability:'chat',runtime:'ollama',model:'imported-'+id+':v1',source:'custom',manifestSha256:null,dimension:null,revision:1,createdAt:'2026-10-29T12:00:00Z',updatedAt:'2026-10-29T12:00:00Z',fileImport:{format:'gguf',uploadId:id,sha256:'a'.repeat(64),bytes:4,fileName:'owned.gguf',architecture:'llama',version:3}});
export function fakeApi(){return {
    limits:vi.fn(async()=>policy),lookup:vi.fn(async()=>{throw {response:{status:404}};}),create:vi.fn(async()=>receipt()),
    upload:vi.fn(async()=>receipt('READY')),accept:vi.fn(async()=>imported()),cancel:vi.fn(async()=>receipt('CANCELLED')),model:vi.fn(async()=>imported()),
} as {[K in keyof GgufImportApi]:ReturnType<typeof vi.fn<GgufImportApi[K]>>};}
export function memoryStorage(){const map=new Map<string,string>();return {map,getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},removeItem:(key:string)=>{map.delete(key);}};}
