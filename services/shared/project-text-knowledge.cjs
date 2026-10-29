/** Shared, browser-safe bounds for explicit text knowledge; no embedding or model operations. */
const TEXT_KNOWLEDGE_LIMITS=Object.freeze({documents:16,fileBytes:128*1024,batchBytes:512*1024,pathBytes:512,queryBytes:2048,sources:6,excerptBytes:3072});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'PROJECT_TEXT_INVALID'});};
function textBytes(value){
    if(typeof value!=='string')fail('Нужен текст в UTF-8.');
    let bytes=0;for(const char of value){const n=char.codePointAt(0);if(n>=0xd800&&n<=0xdfff)fail('Текст содержит некорректные символы.');bytes+=n<128?1:n<2048?2:n<65536?3:4;}return bytes;
}
function normalizeTextUpload(value){
    if(!exact(value,['requestKey','expectedRevision','documents'])||!uuid(value.requestKey)||!integer(value.expectedRevision)
        ||!Array.isArray(value.documents)||!value.documents.length||value.documents.length>TEXT_KNOWLEDGE_LIMITS.documents)fail('Нужны ключ повтора, ревизия и от 1 до 16 текстовых файлов.');
    const names=new Set();let bytes=0;
    const documents=value.documents.map(document=>{
        if(!exact(document,['path','content'])||typeof document.path!=='string'||!document.path||textBytes(document.path)>TEXT_KNOWLEDGE_LIMITS.pathBytes
            ||/[\\\x00-\x1f\x7f]/.test(document.path)||document.path.split('/').some(part=>!part||part==='.'||part==='..')||names.has(document.path))fail('Нужно уникальное относительное имя каждого файла без перехода в другие папки.');
        if(typeof document.content!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(document.content)||textBytes(document.content)>TEXT_KNOWLEDGE_LIMITS.fileBytes)fail('Выберите текстовый файл размером до 128 КиБ.');
        names.add(document.path);bytes+=textBytes(document.content)+textBytes(document.path);
        return {path:document.path,content:document.content};
    });
    if(bytes>TEXT_KNOWLEDGE_LIMITS.batchBytes)fail('Общий размер загрузки превышает 512 КиБ.');
    return {requestKey:value.requestKey,expectedRevision:value.expectedRevision,documents};
}
function normalizeTextSearch(value){
    if(!exact(value,['query'],['revision'])||typeof value.query!=='string'||!value.query.trim()||value.query.includes('\0')
        ||textBytes(value.query)>TEXT_KNOWLEDGE_LIMITS.queryBytes||value.revision!==undefined&&!integer(value.revision))fail('Введите поисковый запрос до 2048 байт и актуальную ревизию.');
    return {query:value.query,...(value.revision===undefined?{}:{revision:value.revision})};
}
function normalizeTextContext(value){
    if(!exact(value,['mode','revision','corpusHash','query'])||value.mode!=='text'||!integer(value.revision)||!sha(value.corpusHash))fail('Выберите актуальную текстовую базу знаний.');
    const query=normalizeTextSearch({query:value.query}).query;
    return {mode:'text',revision:value.revision,corpusHash:value.corpusHash,query};
}
/** Canonical request bytes retain document order, exact paths and all content whitespace. */
const textUploadCanonical=value=>JSON.stringify(normalizeTextUpload(value));
module.exports={TEXT_KNOWLEDGE_LIMITS,normalizeTextUpload,normalizeTextSearch,normalizeTextContext,textUploadCanonical,textBytes};
