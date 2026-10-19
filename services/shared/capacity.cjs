'use strict';
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const resources=['postgres','wal','skills','projects','backups','runtime-artifacts'];
const snapshotFile='/capacity/snapshot.json';
const maxAgeMs=90000;
const reserveBytes=1024**3;
const rejections=new Map();
const queues=new Map();

/** Ошибка не содержит путей, строк соединения или Docker-диагностики. */
class CapacityError extends Error {
    constructor(code,resource){
        super(code==='CAPACITY_LOW'?'Недостаточно свободного места с учётом резерва. Операция не начата. Обратитесь к администратору.':'Сведения о свободном месте недоступны или устарели. Операция не начата. Обратитесь к администратору.');
        this.code=code;this.resource=resource;this.statusCode=code==='CAPACITY_LOW'?507:503;
    }
}
function reject(code,resource){
    const key=resource+':'+code;rejections.set(key,(rejections.get(key)||0)+1);throw new CapacityError(code,resource);
}
function validateSnapshot(value,now=Date.now()){
    if(value?.schemaVersion!==1||!Number.isSafeInteger(value.observedAt)||value.observedAt>now+5000||now-value.observedAt>maxAgeMs||!value.resources||typeof value.resources!=='object'){throw new Error('snapshot');}
    for(const key of resources){
        const item=value.resources[key];
        if(!item||item.available!==true||!Number.isSafeInteger(item.totalBytes)||item.totalBytes<=0||!Number.isSafeInteger(item.freeBytes)||item.freeBytes<0||item.freeBytes>item.totalBytes||typeof item.filesystem!=='string'||!/^\d+$/.test(item.filesystem)){throw new Error('resource');}
    }
    return value;
}
function readSnapshot(now=Date.now()){
    const info=fs.lstatSync(snapshotFile);
    if(!info.isFile()||info.isSymbolicLink()||info.size>32768){throw new Error('snapshot');}
    return validateSnapshot(JSON.parse(fs.readFileSync(snapshotFile,'utf8')),now);
}
function integer(value){if(!Number.isSafeInteger(value)||value<0){throw new TypeError('Нужна безопасная оценка объёма операции.');}return value;}
function safeNumber(value){if(value>BigInt(Number.MAX_SAFE_INTEGER)||value<0n){throw new Error('capacity');}return Number(value);}

/** Резерв одного процесса учитывает конкуренцию и завершённые записи до следующего замера. */
function createCapacityGuard({required=()=>process.env.CAPACITY_REQUIRED==='true',snapshot=readSnapshot,statfs=fsp.statfs,stat=fsp.stat,now=Date.now}={}){
    const reservations=new Map();
    return async function reserve({resource,bytes,path:directory}){
        if(!resources.includes(resource)){throw new TypeError('Неизвестный ресурс.');}
        bytes=integer(bytes);if(bytes===0){return ()=>{};}
        let sample;
        if(required()){
            try{sample=validateSnapshot(await snapshot(now()),now());}catch{reject('CAPACITY_UNAVAILABLE',resource);}
        }
        let local;
        if(directory){
            try{
                const [disk,info]=await Promise.all([statfs(directory,{bigint:true}),stat(directory)]);
                local={freeBytes:safeNumber(disk.bavail*disk.bsize),filesystem:String(info.dev)};
                if(sample&&local.filesystem!==sample.resources[resource].filesystem){reject('CAPACITY_UNAVAILABLE',resource);}
            }catch(error){if(error instanceof CapacityError){throw error;}reject('CAPACITY_UNAVAILABLE',resource);}
        }
        if(!sample&&!local){return ()=>{};}
        const item=sample?.resources[resource]||local;
        const key=item.filesystem;
        const epoch=sample?.observedAt||0;
        let state=reservations.get(key);
        if(!state){state={active:0,spent:0,epoch};reservations.set(key,state);}
        if(state.epoch!==epoch){state.spent=0;state.epoch=epoch;}
        const requiredBytes=reserveBytes+bytes+state.active;
        if(item.freeBytes-state.spent<requiredBytes||local&&local.freeBytes<requiredBytes){reject('CAPACITY_LOW',resource);}
        state.active+=bytes;
        let released=false;
        // Запись могла завершиться после нового замера; её резерв удерживается до следующего snapshot.
        return ()=>{if(released){return;}released=true;state.active-=bytes;if(sample){state.spent+=bytes;}};
    };
}
const reserveCapacity=createCapacityGuard();
function recordCapacityQueue(name,pending,active){
    if(!['rag'].includes(name)){throw new TypeError('Неизвестная очередь.');}
    queues.set(name,{pending:integer(pending),active:integer(active)});
}
/** Отсутствующие значения не превращаются в нулевой размер или здоровый диск. */
function renderCapacityMetrics(){
    const lines=[];let sample;
    if(process.env.CAPACITY_REQUIRED==='true'){
        try{sample=readSnapshot();}catch{}
        lines.push('# TYPE neurocenter_capacity_snapshot_available gauge','neurocenter_capacity_snapshot_available '+(sample?1:0));
        if(sample){
            lines.push('# TYPE neurocenter_capacity_snapshot_age_seconds gauge','neurocenter_capacity_snapshot_age_seconds '+Math.max(0,(Date.now()-sample.observedAt)/1000));
            for(const [resource,item] of Object.entries(sample.resources)){
                for(const [metric,value] of [['free_bytes',item.freeBytes],['total_bytes',item.totalBytes],['wal_bytes',item.walBytes]]){
                    if(Number.isSafeInteger(value)&&value>=0){lines.push('neurocenter_capacity_'+metric+'{resource="'+resource+'"} '+value);}
                }
            }
        }
    }
    for(const [key,value] of rejections){const [resource,reason]=key.split(':');lines.push('neurocenter_capacity_rejections_total{resource="'+resource+'",reason="'+reason+'"} '+value);}
    for(const [queue,value] of queues){lines.push('neurocenter_work_queue_pending{queue="'+queue+'"} '+value.pending,'neurocenter_work_queue_active{queue="'+queue+'"} '+value.active);}
    return lines.join('\n');
}
function getCapacityStatus({required=()=>process.env.CAPACITY_REQUIRED==='true',snapshot=readSnapshot}={}){
    if(!required()){return {available:false,reason:'CAPACITY_NOT_CONFIGURED'};}
    try{const value=snapshot();return {available:true,observedAt:new Date(value.observedAt).toISOString(),maxAgeSeconds:maxAgeMs/1000,reserveBytes,resources:value.resources};}
    catch{return {available:false,reason:'CAPACITY_UNAVAILABLE',maxAgeSeconds:maxAgeMs/1000};}
}
module.exports={getCapacityStatus,CapacityError,createCapacityGuard,reserveCapacity,recordCapacityQueue,renderCapacityMetrics,validateSnapshot,resources,maxAgeMs,reserveBytes};
