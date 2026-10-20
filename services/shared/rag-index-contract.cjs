'use strict';
const {createHash}=require('node:crypto');
const FINGERPRINT_VERSION=1;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clean=value=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,''):null;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Ключ повтора зависит от JSON-значений, а не порядка ключей после JSONB roundtrip. */
function ragRequestHash(value){
 const canonical=item=>Array.isArray(item)?item.map(canonical):object(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
 return hash(canonical(value));
}

/** Только идентичность модели: адрес подключения и секреты в контракт не входят. */
function normalizeIndexProfile(value){
 if(value===undefined||value===null)return null;
 if(!object(value)||Object.keys(value).sort().join(',')!=='dimension,model,provider'
  ||typeof value.provider!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(value.provider)
  ||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value.model)||value.model.includes('://')
  ||!Number.isSafeInteger(value.dimension)||value.dimension<1||value.dimension>65535){throw new Error('Некорректный профиль индекса: нужны только provider, model и dimension.');}
 return {provider:value.provider,model:value.model,dimension:value.dimension};
}

/** Один формат текстов, nullable-полей и float32 для LanceDB и PostgreSQL. */
function normalizeChunkRow(value){
 if(!object(value)||typeof value.id!=='string'||typeof value.filePath!=='string'||typeof value.content!=='string')throw new Error('Фрагменту нужны строковые id, filePath и content.');
 let embedding=null;
 if(value.embedding!==undefined&&value.embedding!==null){
  if(!Array.isArray(value.embedding)||value.embedding.some(number=>typeof number!=='number'||!Number.isFinite(Math.fround(number))))throw new Error('Вектор содержит некорректное число float32.');
  embedding=value.embedding.map(number=>Object.is(Math.fround(number),-0)?0:Math.fround(number));
 }
 return {id:value.id,filePath:clean(value.filePath),content:clean(value.content),description:clean(value.description),
  startLine:value.startLine??null,endLine:value.endLine??null,language:clean(value.language),kind:clean(value.kind)??'',
  role:clean(value.role),quirkType:clean(value.quirkType),tags:clean(value.tags),embedding};
}

/** Полный отпечаток меняется при изменении вектора или метаданных, даже без изменения content. */
function rowFingerprint(value){return hash(normalizeChunkRow(value));}

/** Порядок строк не влияет на seal; разные профили не разделяют один снимок. */
function indexSnapshotHash(profile,fingerprints){
 const normalized=normalizeIndexProfile(profile);
 if(!normalized||!object(fingerprints))throw new Error('Снимку нужен профиль и полные отпечатки строк.');
 const entries=Object.entries(fingerprints);
 if(entries.some(([id,fingerprint])=>!id||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint)))throw new Error('Некорректный отпечаток строки снимка.');
 entries.sort(([left],[right])=>left<right?-1:left>right?1:0);
 return hash([FINGERPRINT_VERSION,normalized,entries]);
}
/** Локальная идентичность подключения без сохранения адреса, credentials или query-секретов. */
function embeddingSignature(profile,baseUrl){
 const normalized=normalizeIndexProfile(profile);
 if(!normalized)throw new Error('Подключению нужен профиль индекса.');
 let endpoint='';
 if(baseUrl!==undefined&&baseUrl!==null&&baseUrl!==''){
  if(typeof baseUrl!=='string')throw new Error('Некорректный адрес провайдера эмбеддингов.');
  let parsed;try{parsed=new URL(baseUrl);}catch{throw new Error('Некорректный адрес провайдера эмбеддингов.');}
  if(!['http:','https:'].includes(parsed.protocol))throw new Error('Некорректный адрес провайдера эмбеддингов.');
  parsed.username='';parsed.password='';parsed.search='';parsed.hash='';
  endpoint=parsed.toString().replace(/\/+$/,'');
 }
 return hash([FINGERPRINT_VERSION,normalized,endpoint]);
}
/** Только локальные defaults управляемого плагина; явные параметры проекта имеют приоритет. */
function managedEmbeddingConfiguration(value={}){
 if(!object(value))throw new Error('Некорректные локальные настройки embedding-модели.');
 const provider=value.provider??'ollama';
 const model=value.model??'qwen3-embedding:4b';
 const baseUrl=value.baseUrl??(provider==='ollama'?'http://127.0.0.1:11435/api':provider==='openai'?'http://127.0.0.1:11435/v1':undefined);
 let vectorDimension=value.vectorDimension;
 if(vectorDimension===undefined&&model==='qwen3-embedding:4b'){
  try{const url=new URL(baseUrl);if(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.port==='11435'
   &&url.pathname.replace(/\/+$/,'')===(provider==='ollama'?'/api':provider==='openai'?'/v1':'')&&!url.username&&!url.password&&!url.search&&!url.hash)vectorDimension=2560;}catch{}
 }
 return {provider,model,...baseUrl!==undefined?{baseUrl}:{},...vectorDimension!==undefined?{vectorDimension}:{}};
}
module.exports={FINGERPRINT_VERSION,normalizeIndexProfile,normalizeChunkRow,rowFingerprint,indexSnapshotHash,embeddingSignature,managedEmbeddingConfiguration,ragRequestHash};
