'use strict';

const protectedKeys=new Set(['model','messages','input','prompt','instructions','system','developer','images','tools','toolchoice','functions','functioncall','paralleltoolcalls','maxtoolcalls','previousresponseid','conversation','stream','streamoptions','headers','authorization','apikey','accesstoken','refreshtoken','password','secret','clientsecret','credential','credentials','baseurl','endpoint','url','fetch','timeout','timeoutms','signal','adapter','protocol','apiformat','responsemodel','requestdimensions','dimensions','providerparameters']);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const fail=message=>{throw Object.assign(new Error(message),{code:'ADAPTER_PARAMETERS_INVALID'});};

/** Adapter definitions declare the wire owner; parameter count is bounded by resources, not an allowlist. */
const ADAPTER_PARAMETER_DEFINITIONS=Object.freeze(Object.fromEntries([
 ['openai-chat-completions',[]],['openai-responses',[]],['ollama',['options']],
].map(([id,wirePath])=>[id,Object.freeze({id,wirePath:Object.freeze(wirePath),protectedKeys:Object.freeze([...protectedKeys]),maximumBytes:65536,maximumDepth:8,maximumNodes:4096})])));

/** JSON only: preserves unknown nested fields, false and null, and rejects transport/control overrides. */
function normalizeAdapterParameters(value,definition=ADAPTER_PARAMETER_DEFINITIONS['openai-chat-completions']){
 if(!plain(value))return fail('Параметры адаптера должны быть JSON-объектом.');
 let nodes=0,bytes=0;
 const account=count=>{bytes+=count;if(bytes>definition.maximumBytes)return fail('Параметры адаптера превышают 64 КиБ.');};
 const visit=(item,depth)=>{
  if(++nodes>definition.maximumNodes||depth>definition.maximumDepth)return fail('Параметры адаптера превышают допустимую вложенность или размер структуры.');
  if(item===null||typeof item==='boolean'||typeof item==='string'||typeof item==='number'&&Number.isFinite(item)){
   if(typeof item==='string'&&item.length>definition.maximumBytes)return fail('Параметры адаптера превышают 64 КиБ.');
   account(Buffer.byteLength(JSON.stringify(item)));return item;
  }
  if(Array.isArray(item)){
   if(item.length>definition.maximumNodes||Object.keys(item).length!==item.length||Array.from({length:item.length},(_,index)=>index).some(index=>!Object.hasOwn(item,index)))return fail('Параметры адаптера содержат массив вне JSON.');
   account(2+Math.max(0,item.length-1));return item.map(child=>visit(child,depth+1));
  }
  if(!plain(item))return fail('Параметры адаптера содержат значение вне JSON.');
  const result={},entries=Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0);account(2+Math.max(0,entries.length-1));
  for(const [key,child]of entries){
   if(!key||key.length>128||/[\x00-\x1f\x7f]/.test(key)||['__proto__','constructor','prototype'].includes(key))return fail('Недопустимое имя параметра адаптера.');
   if(depth===0&&protectedKeys.has(key.toLowerCase().replace(/[_-]/g,'')))return fail('Модель, сообщения, инструменты, адрес, транспорт и авторизация задаются отдельно от параметров адаптера.');
   account(Buffer.byteLength(JSON.stringify(key))+1);
   result[key]=visit(child,depth+1);
  }
  return result;
 };
 const result=visit(value,0);
 if(Buffer.byteLength(JSON.stringify(result))>definition.maximumBytes)return fail('Параметры адаптера превышают 64 КиБ.');
 return result;
}

/** Merge only into an adapter-declared body path; conflicting defaults are rejected rather than dropped. */
function applyAdapterParameters(body,parameters,definition){
 const checked=normalizeAdapterParameters(parameters,definition),result={...body};let target=result;
 for(const key of definition.wirePath){if(target[key]!==undefined&&!plain(target[key]))return fail('Путь параметров адаптера занят несовместимым значением.');target[key]={...target[key]};target=target[key];}
 for(const [key,value]of Object.entries(checked)){if(Object.hasOwn(target,key))return fail('Параметр адаптера уже задан основной формой: '+key+'. Укажите его в одном месте.');target[key]=value;}
 return result;
}

/** Public discovery diagnostics contain names/types only; unknown values stay in the original local config. */
function adapterParameterIssues(value,known){
 if(!plain(value))return [];
 return Object.entries(value).filter(([name])=>!known.includes(name)).slice(0,100).map(([name,item])=>({
  name:/^[a-zA-Z0-9_.-]{1,80}$/.test(name)?name:'[недопустимое имя]',
  type:item===null?'null':Array.isArray(item)?'array':typeof item==='object'?'object':typeof item,
 }));
}

module.exports={ADAPTER_PARAMETER_DEFINITIONS,normalizeAdapterParameters,applyAdapterParameters,adapterParameterIssues};
