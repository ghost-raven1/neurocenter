import {BadRequestException,ServiceUnavailableException} from '@nestjs/common';
import {createHash} from 'node:crypto';
import {validateModelId} from '../models/model-validation';
import {CHAT_SEARCH_CHUNK,type ChatSearchInput} from './chat-search.types';
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const chatSearchHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Consent and a pinned embedding model apply to one explicit bounded operation. */
export function chatSearchInput(raw:unknown,kind:'index'|'search'):ChatSearchInput {
    const value=raw as Record<string,unknown>,max=kind==='index'?32:20;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['requestKey','modelId','expectedModelPin','consent','roomId','limit',...(kind==='search'?['query']:[])].includes(key))
        ||!uuid(value.requestKey)||typeof value.expectedModelPin!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedModelPin)||value.consent!==true
        ||value.roomId!==undefined&&!uuid(value.roomId)||value.limit!==undefined&&(!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>max)
        ||kind==='search'&&(typeof value.query!=='string'||!value.query.trim()||Buffer.byteLength(value.query)>8192))throw new BadRequestException('Выберите embedding-модель и её pin, подтвердите передачу текста и передайте ключ запроса.');
    return {requestKey:value.requestKey,modelId:validateModelId(value.modelId),expectedModelPin:value.expectedModelPin,consent:true,
        ...(value.roomId?{roomId:String(value.roomId)}:{}),limit:Number(value.limit??(kind==='index'?32:10)),...(kind==='search'?{query:String(value.query).trim()}:{})};
}
/** PostgreSQL substring and this code use Unicode codepoints, including supplementary characters. */
export function chatSearchChunk(text:string|readonly string[],index:number):string{return (typeof text==='string'?Array.from(text):text).slice(index*CHAT_SEARCH_CHUNK,(index+1)*CHAT_SEARCH_CHUNK).join('');}
export function embeddingVectors(value:unknown,count:number,dimension:number):number[][] {
    if(!Array.isArray(value)||value.length!==count||value.some(vector=>!Array.isArray(vector)||vector.length!==dimension
        ||vector.some(x=>typeof x!=='number'||!Number.isFinite(x)||!Number.isFinite(Math.fround(x)))||!vector.some(x=>Math.fround(x)!==0)))throw new ServiceUnavailableException('Embedding-модель вернула неполные или несовместимые векторы.');
    return value as number[][];
}
/** Cosine similarity compares real vectors; there is no lexical fallback. */
export function cosine(a:readonly number[],b:readonly number[]):number {
    let dot=0,aa=0,bb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
    return dot/Math.sqrt(aa*bb);
}
