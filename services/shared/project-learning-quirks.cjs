'use strict';
const {createHash}=require('node:crypto');
const QUIRKS_LIMITS=Object.freeze({bytes:1024*1024,totalBytes:1024*1024,records:1000,recordBytes:16384,contentBytes:8192,importedExperiences:1000,receiptBytes:1024});
const QUIRKS_SOURCE_SHA256='6a21f4e39748394e56400364990f90ae0c9518cf6d16f62623fe664a951358af';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&Buffer.from(value).toString('utf8')===value;
const optionalText=(value,max)=>typeof value==='string'&&Buffer.byteLength(value)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)&&Buffer.from(value).toString('utf8')===value;
const sha=value=>typeof value==='string'&&SHA.test(value);
const fail=()=>{throw new Error('Кварки RAG повреждены, изменились или превышают лимит. Исправьте источник и повторите сбор.');};
const quota=limit=>{throw Object.assign(new Error('Сбор кварков превышает квоту. Уменьшите источник или измените квоту в настройках и повторите сбор; опыт не записан.'),{code:'LEARNING_QUIRKS_QUOTA',limit});};
const digest=value=>createHash('sha256').update(value).digest('hex');
/** Server-owned limits may tighten physical boundaries; a job cannot expand the reader's hard ceiling. */
function normalizeQuirksLimits(value={}){
    if(!exact(value,[],Object.keys(QUIRKS_LIMITS)))fail();
    const limits={...QUIRKS_LIMITS,...value};
    for(const key of Object.keys(QUIRKS_LIMITS))if(!Number.isSafeInteger(limits[key])||limits[key]<(key==='importedExperiences'?0:1)||limits[key]>QUIRKS_LIMITS[key])fail();
    return limits;
}
function normalizeQuirk(value){
    if(!exact(value,['id','content','tags','confidence','lastObserved'],['quirkType','sourceRef'])||!text(value.id,256)||!/^quirk:[a-f0-9-]{36}$/.test(value.id)||!UUID.test(value.id.slice(6))
        ||!text(value.content,QUIRKS_LIMITS.contentBytes)||!Array.isArray(value.tags)||value.tags.length>50||value.tags.some(tag=>!optionalText(tag,256))
        ||typeof value.confidence!=='number'||!Number.isFinite(value.confidence)
        ||typeof value.lastObserved!=='string'||!Number.isFinite(Date.parse(value.lastObserved))||new Date(value.lastObserved).toISOString()!==value.lastObserved
        ||value.quirkType!==undefined&&!optionalText(value.quirkType,256)||value.sourceRef!==undefined&&!optionalText(value.sourceRef,1024))fail();
    return JSON.parse(JSON.stringify(value));
}
/** JSONL is the source of truth: every record is checked before the first append. */
function parseQuirksJsonl(value,settings){
    const limits=normalizeQuirksLimits(settings);
    if(typeof value!=='string')fail();if(Buffer.byteLength(value)>Math.min(limits.bytes,limits.totalBytes))quota('bytes');
    if(Buffer.from(value).toString('utf8')!==value||value.length>0&&!value.endsWith('\n'))fail();
    const fileSha256=digest(value),records=[],seen=new Set();
    if(value.trim()==='')return {fileSha256,records};
    const lines=value.split('\n');lines.pop();
    if(lines.length>limits.records)quota('records');
    for(const line of lines){
        if(Buffer.byteLength(line)>limits.recordBytes)quota('recordBytes');if(!line.trim())fail();
        let parsed;try{parsed=JSON.parse(line);}catch{fail();}
        if(typeof parsed?.content==='string'&&Buffer.byteLength(parsed.content)>limits.contentBytes)quota('contentBytes');
        let quirk;try{quirk=normalizeQuirk(parsed);}catch{fail();}
        if(seen.has(quirk.id))fail();seen.add(quirk.id);
        records.push({quirk,recordSha256:digest(line)});
    }
    return {fileSha256,records};
}
/** Existing immutable records consume no new-experience budget, including retries of a changed file. */
function preflightQuirkImport(snapshot,target,existingIds,maximum=QUIRKS_LIMITS.importedExperiences){
    if(!Number.isSafeInteger(maximum)||maximum<0||maximum>QUIRKS_LIMITS.importedExperiences)fail();
    const existing=new Set(existingIds),newCount=snapshot.records.filter(entry=>!existing.has(quirkExperienceKey(target.projectId,target.instanceId,entry.quirk.id,entry.recordSha256))).length;
    if(newCount>maximum)quota('importedExperiences');return {newCount,existingCount:snapshot.records.length-newCount};
}
/** Import identity ignores file ordering and import attempts; changed bytes produce new experience. */
function quirkExperienceKey(projectId,instanceId,quirkId,recordSha256){
    if(!text(projectId,128)||!UUID.test(instanceId)||!text(quirkId,256)||!sha(recordSha256))fail();
    const hex=digest(JSON.stringify(['neurocenter:rag-quirk:v1',projectId,instanceId,quirkId,recordSha256])).slice(0,32).split('');
    hex[12]='5';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);const id=hex.join('');
    return [id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-');
}
function normalizeQuirkSource(value){
    if(!exact(value,['kind','trust','quirk','recordSha256','fileSha256','assetId','assetKind','version','manifest','configurationRevision'])
        ||value.kind!=='rag_quirk'||value.trust!=='reported'||!sha(value.recordSha256)||!sha(value.fileSha256)||!text(value.assetId,200)
        ||!['mcp','plugin'].includes(value.assetKind)||!Number.isSafeInteger(value.version)||value.version<1||!sha(value.manifest)
        ||value.configurationRevision!==null&&(typeof value.configurationRevision!=='string'||!UUID.test(value.configurationRevision)))fail();
    return {...value,quirk:normalizeQuirk(value.quirk)};
}
/** Confidence remains reported metadata. No successful check or approved knowledge is synthesized. */
function quirkReportedExperience(target,entry,source){
    const provenance=normalizeQuirkSource({kind:'rag_quirk',trust:'reported',quirk:entry.quirk,recordSha256:entry.recordSha256,...source});
    return {requestKey:quirkExperienceKey(target.projectId,target.instanceId,entry.quirk.id,entry.recordSha256),title:'Кварк RAG: '+entry.quirk.id,summary:entry.quirk.content,outcome:'unknown',
        evidence:[{kind:'observation',status:'unknown',summary:'Сообщённый кварк RAG. Содержание и уверенность источника требуют независимой проверки.',sha256:entry.recordSha256}],context:{},source:provenance};
}
function normalizeQuirksReceipt(value){
    if(!exact(value,['schemaVersion','status','sourceCount','imported','skipped','remaining','fileSha256','safeRetry'])||value.schemaVersion!==1||!['complete','partial'].includes(value.status)
        ||['sourceCount','imported','skipped','remaining'].some(key=>!Number.isSafeInteger(value[key])||value[key]<0)||value.sourceCount>QUIRKS_LIMITS.records
        ||value.imported+value.skipped+value.remaining!==value.sourceCount||!sha(value.fileSha256)||value.safeRetry!==true||value.status==='complete'&&value.remaining!==0)fail();
    if(Buffer.byteLength(JSON.stringify(value))>QUIRKS_LIMITS.receiptBytes)fail();return {...value};
}
/** Only a prepared package declaring the reviewed upstream schema can select this reader. */
function supportsLearningQuirks(pkg){
    const value=pkg?.config?.extra?.learningQuirks;
    return pkg?.schemaVersion===5&&['mcp','plugin'].includes(pkg?.plugin?.kind)&&pkg?.config?.transport!=='remote'
        &&exact(value,['schemaVersion','format','sourceSha256'])&&value.schemaVersion===1&&value.format==='opencode-rag-quirks-jsonl'&&value.sourceSha256===QUIRKS_SOURCE_SHA256;
}
module.exports={QUIRKS_LIMITS,QUIRKS_SOURCE_SHA256,supportsLearningQuirks,normalizeQuirksLimits,parseQuirksJsonl,preflightQuirkImport,normalizeQuirkSource,quirkExperienceKey,quirkReportedExperience,normalizeQuirksReceipt};
