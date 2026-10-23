import {parse,parseTree,modify,applyEdits,type ParseError,type Node} from 'jsonc-parser';
import {isDeepStrictEqual} from 'node:util';
const duplicate=(node:Node|undefined):boolean=>!!node&&((node.type==='object'&&new Set(node.children?.map(child=>child.children?.[0]?.value)).size!==node.children?.length)||!!node.children?.some(duplicate));
export const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Reject duplicate keys rather than previewing a different object from the runtime. */
export function configurationObject(raw:string|null,strict=false):Record<string,unknown>{
    const text=raw??'{}',errors:ParseError[]=[];let value:unknown;
    try{value=strict?JSON.parse(text.replace(/^\uFEFF/,'')):parse(text,errors,{allowTrailingComma:true});}catch{throw Error('Исправьте синтаксис JSON.');}
    if(errors.length||!object(value)||duplicate(parseTree(text)))throw Error('Нужен JSON-объект без повторяющихся ключей.');return value;
}
export interface RagFields {topK?:number;minScore?:number;excludeDirs?:string[];includeExtensions?:string[]}
export function ragFields(value:Record<string,unknown>):RagFields{
    const retrieval=object(value.retrieval)?value.retrieval:{},indexing=object(value.indexing)?value.indexing:{};
    return {topK:retrieval.topK as number|undefined,minScore:retrieval.minScore as number|undefined,excludeDirs:indexing.excludeDirs as string[]|undefined,includeExtensions:indexing.includeExtensions as string[]|undefined};
}
export function validateRagFields(input:unknown):asserts input is RagFields{
    if(!object(input)||Object.keys(input).some(key=>!['topK','minScore','excludeDirs','includeExtensions'].includes(key)))throw Error('Неизвестное поле RAG.');
    if(input.topK!==undefined&&(!Number.isSafeInteger(input.topK)||Number(input.topK)<1||Number(input.topK)>1000))throw Error('Количество результатов: целое от 1 до 1000.');
    if(input.minScore!==undefined&&(typeof input.minScore!=='number'||!Number.isFinite(input.minScore)||input.minScore<0||input.minScore>1))throw Error('Минимальная оценка: от 0 до 1.');
    for(const key of ['excludeDirs','includeExtensions'] as const){const value=input[key];if(value!==undefined&&(!Array.isArray(value)||value.length>100||value.some(item=>typeof item!=='string'||!item||item.length>200||/[\x00-\x1f\x7f]/.test(item)||key==='includeExtensions'&&!/^\.[a-zA-Z0-9_-]+$/.test(item))||new Set(value).size!==value.length))throw Error('Проверьте список расширений или исключённых папок.');}
}
export function updateRagFields(raw:string|null,input:unknown):string{
    const previous=configurationObject(raw,true);validateRagFields(input);let text=raw??'{}\n';
    for(const key of Object.keys(input) as Array<keyof RagFields>){const section=['topK','minScore'].includes(key)?'retrieval':'indexing';if(isDeepStrictEqual(object(previous[section])?previous[section][key]:undefined,input[key]))continue;text=applyEdits(text,modify(text,[section,key],input[key],{formattingOptions:{insertSpaces:true,tabSize:2}}));}
    return text;
}
export function preserveRagProfile(before:Record<string,unknown>,after:Record<string,unknown>,managed:boolean){
    validateRagFields(ragFields(after));
    if(managed&&['embedding','vectorStore'].some(key=>!isDeepStrictEqual(before[key],after[key])))throw Error('Модель и хранилище управляются подключением Neurocenter. Измените модель на сайте; черновик сохранён.');
}
