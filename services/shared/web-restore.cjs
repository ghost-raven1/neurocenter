'use strict';
const {createHash}=require('node:crypto');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const project=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{2,62}$/.test(value);
const checkpoint=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const restoreFailureMessages=Object.freeze({CHECKPOINT_INVALID:'Файлы полной копии изменены или не совпадают с описью и SHA-256.',TARGET_EXISTS:'Новый стек или хранилище уже существует. Выберите другое пустое назначение.',CONFIG_CHANGED:'Конфигурация изменилась после проверки. Подготовьте новую проверку.',IMAGES_CHANGED:'Образы выбранного релиза не совпадают с сохранённой копией.',MODEL_KEY_MISMATCH:'Ключ шифрования моделей не соответствует копии. Оператору нужно восстановить исходный закрытый ключ.',SNAPSHOT_STORAGE_UNAVAILABLE:'Не подтверждены хранилище снимков, точные версии объектов или ключи подписи. Оператору нужно проверить закрытую конфигурацию и комплект.',SNAPSHOT_WRITES_PENDING:'Копия содержит незавершённую запись блока снимка. Дождитесь штатной очистки на исходной площадке и создайте новую полную копию.',SOURCE_RESERVED:'Копия используется другим восстановлением или ожидает проверки после сбоя.',AUTHORIZATION_REVOKED:'Права администратора отозваны; следующая запись остановлена.',CHECKPOINT_UNAVAILABLE:'Копия или её файлы больше недоступны.',NO_SPACE:'Недостаточно места для восстановления.',EXECUTION_FAILED:'Исполнитель не подтвердил завершение. Оператору нужно проверить закрытый журнал.'});
/** Ошибка становится фиксированным кодом; PostgreSQL stderr, пути и секреты не выдаются браузеру. */
function restoreFailureCode(error){
 const message=typeof error?.message==='string'?error.message:'';
 if(['ENOSPC','EDQUOT'].includes(error?.code))return 'NO_SPACE';
 if(/RESTORE_CONTROL_403|разрешени.*отозван|права.*отозван/i.test(message))return 'AUTHORIZATION_REVOKED';
 if(/конфигураци.*измен/i.test(message))return 'CONFIG_CHANGED';
 if(/новый Compose-проект|целевой.*не пуст|целевой том.*не пуст|Target bucket.*существует/i.test(message))return 'TARGET_EXISTS';
 if(/те же образы|образы.*расход/i.test(message))return 'IMAGES_CHANGED';
 if(/Ключ шифрования моделей/i.test(message))return 'MODEL_KEY_MISMATCH';
 if(/зарезервирована/i.test(message))return 'SOURCE_RESERVED';
 if(error?.code==='ENOENT')return 'CHECKPOINT_UNAVAILABLE';
 if(/незавершённ.*запис.*блок.*снимк/i.test(message))return 'SNAPSHOT_WRITES_PENDING';
 if(/описи|SHA256|SHA-256|Ссылки|файл.*измен|копи.*соответ/i.test(message))return 'CHECKPOINT_INVALID';
 if(/S3|MinIO|bucket|snapshot objects|снимк.*(?:ключ|keyring)|ключ.*снимк|снимк.*подпис|Подписанн.*сним/i.test(message)||['NoSuchVersion','NoSuchKey','AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch','NoSuchBucket'].includes(error?.code))return 'SNAPSHOT_STORAGE_UNAVAILABLE';
 return 'EXECUTION_FAILED';
}
function previewRequest(input){
 if(!exact(input,['requestKey','checkpointId','checkpointSha256','targetProject'])||!uuid(input.requestKey)||!checkpoint(input.checkpointId)||!sha(input.checkpointSha256)||!project(input.targetProject))throw new Error('Передайте ключ запроса, точную копию, SHA-256 и имя нового стека.');
 return {requestKey:input.requestKey,checkpointId:input.checkpointId,checkpointSha256:input.checkpointSha256,targetProject:input.targetProject};
}
function restoreRequest(input){
 if(!exact(input,['requestKey','previewId','digest','confirmation'])||!uuid(input.requestKey)||!uuid(input.previewId)||!sha(input.digest)||typeof input.confirmation!=='string'||input.confirmation.length>80)throw new Error('Передайте сохранённый ключ запроса и точное подтверждение проверки.');
 return {requestKey:input.requestKey,previewId:input.previewId,digest:input.digest,confirmation:input.confirmation};
}
function checkpointInfo(value){
 if(!exact(value,['id','label','sha256','createdAt'])||!checkpoint(value.id)||typeof value.label!=='string'||value.label.length<1||value.label.length>200||!sha(value.sha256)||!time(value.createdAt))throw new Error('Некорректная опись checkpoint.');
 return {id:value.id,label:value.label,sha256:value.sha256,createdAt:value.createdAt};
}
function runnerReport(value){
 if(!exact(value,['runnerId','configDigest','targetPrefix','checkpoints'])||!uuid(value.runnerId)||!sha(value.configDigest)||!project(value.targetPrefix)||value.targetPrefix.length>40||!Array.isArray(value.checkpoints)||value.checkpoints.length>1000)throw new Error('Некорректный отчёт restore runner.');
 const checkpoints=value.checkpoints.map(checkpointInfo);if(new Set(checkpoints.map(item=>item.id)).size!==checkpoints.length)throw new Error('Повтор checkpoint.');
 return {runnerId:value.runnerId,configDigest:value.configDigest,targetPrefix:value.targetPrefix,checkpoints};
}
function previewResult(value){
 const fields=['checkpointId','checkpointSha256','targetProject','configDigest','checkedAt','expiresAt','impact','digest'];
 if(!exact(value,fields)||!checkpoint(value.checkpointId)||!sha(value.checkpointSha256)||!project(value.targetProject)||!sha(value.configDigest)||!time(value.checkedAt)||!time(value.expiresAt)||Date.parse(value.expiresAt)<=Date.parse(value.checkedAt)||Date.parse(value.expiresAt)-Date.parse(value.checkedAt)>10*60000||!sha(value.digest))throw new Error('Некорректная проверка восстановления.');
 const impact=value.impact;
 if(!exact(impact,['databases','volumes','files','bytes','applicationsStarted','currentStackChanged'])||!Array.isArray(impact.databases)||impact.databases.length<2||impact.databases.length>10000||impact.databases.some(name=>!['catalog','rag'].includes(name)&&!/^nc_rag_[a-f0-9]{32}$/.test(name))||new Set(impact.databases).size!==impact.databases.length||!impact.databases.includes('catalog')||!impact.databases.includes('rag')||!Array.isArray(impact.volumes)||impact.volumes.join(',')!=='skills,projects,backups,runtime-artifacts'||!integer(impact.files)||!integer(impact.bytes)||impact.applicationsStarted!==false||impact.currentStackChanged!==false)throw new Error('Некорректный состав восстановления.');
 const {digest:expected,...body}=value;if(digest(body)!==expected)throw new Error('SHA проверки восстановления изменился.');return value;
}
function restoreReceipt(value){
 if(!exact(value,['ok','projectName','sha256','restoredAt','databases','durationMs','applicationsStarted'])||value.ok!==true||!project(value.projectName)||!sha(value.sha256)||!time(value.restoredAt)||!integer(value.databases)||value.databases<2||!integer(value.durationMs)||value.applicationsStarted!==false)throw new Error('Неполная квитанция восстановления.');return value;
}
module.exports={uuid,sha,project,checkpoint,digest,previewRequest,restoreRequest,checkpointInfo,runnerReport,previewResult,restoreReceipt,restoreFailureMessages,restoreFailureCode};
