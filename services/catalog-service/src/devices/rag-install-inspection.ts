import {ConflictException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {localRagCore} from '../../../shared/rag-core-contract.cjs';
import {verifyPackage,type IPackage} from '../catalog/bundle-package';
import {supportsHostedRag} from './hosted-rag-jobs';
import {verifyInstallationSet,type IInstallationSet} from './installation-set';
import {recordDeviceOperation} from './device-operations';
import type {Device} from './device-store';

type Database=Pick<PoolClient,'query'>;
interface SourceJob {
    id:string;device_id:string;email:string;role:string;project_id:string|null;kind:string;state:string;payload:Record<string,unknown>;
}
interface Continuation {schemaVersion:1;installJobId:string;position:number;instanceId:string}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const invalid=()=>new ConflictException('Автоматическая сверка относится к другой установке или папке. Проверьте файлы из актуального каталога.');

/** Only supported immutable package descriptors opt into readback; a display name never does. */
function packages(payload:Record<string,unknown>):IPackage[]{
    const set=payload.installSet as IInstallationSet|undefined,pkg=payload.package as IPackage|undefined;
    try{
        if(set?!verifyInstallationSet(set):!pkg||!verifyPackage(pkg))return [];
        return (set?.packages??[pkg!]).filter(value=>['mcp','plugin'].includes(value.plugin.kind)&&supportsHostedRag(value)&&localRagCore(value))
            .sort((left,right)=>{const a=left.plugin.kind+':'+left.plugin.id,b=right.plugin.kind+':'+right.plugin.id;return a===b?0:a<b?-1:1;});
    }catch{return [];}
}

function continuation(value:unknown):Continuation{
    const marker=value as Continuation;
    if(!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='installJobId,instanceId,position,schemaVersion'
        ||marker.schemaVersion!==1||!uuid(marker.installJobId)||!uuid(marker.instanceId)||!Number.isSafeInteger(marker.position)||marker.position<0||marker.position>=20)throw invalid();
    return marker;
}

function binding(report:Record<string,unknown>,projectId:string|null,bindingId:unknown):{instanceId:string}|undefined{
    if(!projectId||!sha(bindingId)||!Array.isArray(report.bindings))return;
    return report.bindings.find((value:Record<string,unknown>)=>value?.projectId===projectId&&value.valid!==false&&value.bindingId===bindingId&&uuid(value.instanceId));
}

async function parent(db:Database,id:string,lock=false):Promise<SourceJob>{
    const value=(await db.query<SourceJob>('SELECT * FROM bridge_jobs WHERE id=$1'+(lock?' FOR UPDATE':''),[id])).rows[0];
    if(!value||value.kind!=='install'||value.state!=='succeeded')throw invalid();return value;
}

function assertSource(job:SourceJob,source:SourceJob,marker:Continuation):IPackage[]{
    const members=packages(source.payload),pkg=members[marker.position];
    if(!pkg||job.kind!=='inspect-installation'||job.device_id!==source.device_id||job.email!==source.email||job.role!==source.role
        ||!source.project_id||job.project_id!==source.project_id||!sha(source.payload.bindingId)||job.payload.bindingId!==source.payload.bindingId
        ||job.payload.assetId!==pkg.plugin.id||job.payload.assetKind!==pkg.plugin.kind||job.payload.version!==pkg.plugin.version
        ||!isDeepStrictEqual(job.payload.package,pkg))throw invalid();
    return members;
}

/** Claim and pre-read authorization retain the original folder instance and frozen delivery bytes. */
export async function assertRagAutoInspection(db:Database,device:Device,job:SourceJob):Promise<void>{
    if(job.payload.autoRagInspection===undefined)return;
    const marker=continuation(job.payload.autoRagInspection),source=await parent(db,marker.installJobId);
    assertSource(job,source,marker);
    if(device.id!==job.device_id||device.email!==job.email||binding(device.report,job.project_id,job.payload.bindingId)?.instanceId!==marker.instanceId)throw invalid();
}

/** A completion replaces its one active queue slot with at most one read-only successor. */
export async function continueRagInstallationInspection(db:Database,job:SourceJob,state:'succeeded'|'failed'):Promise<boolean>{
    let source=job,members:IPackage[],position=0,instanceId:string;
    if(job.kind==='install'){
        if(state!=='succeeded')return false;
        members=packages(job.payload);if(!members.length||!job.project_id||!sha(job.payload.bindingId))return false;
        const device=(await db.query<{report:Record<string,unknown>}>('SELECT report FROM bridge_devices WHERE id=$1 AND email=$2 FOR UPDATE',[job.device_id,job.email])).rows[0];
        const current=device&&binding(device.report,job.project_id,job.payload.bindingId);if(!current)return false;
        instanceId=current.instanceId;
    }else{
        if(job.kind!=='inspect-installation'||job.payload.autoRagInspection===undefined)return false;
        const marker=continuation(job.payload.autoRagInspection);source=await parent(db,marker.installJobId,true);
        members=assertSource(job,source,marker);position=marker.position+1;instanceId=marker.instanceId;
    }
    const pkg=members[position];if(!pkg)return false;
    const marker:Continuation={schemaVersion:1,installJobId:source.id,position,instanceId};
    const payload={assetId:pkg.plugin.id,assetKind:pkg.plugin.kind,version:pkg.plugin.version,package:pkg,bindingId:source.payload.bindingId,autoRagInspection:marker};
    // Non-UUID namespace is reserved: the public create endpoint cannot preoccupy an automatic request key.
    const requestKey='auto-rag-inspection:'+createHash('sha256').update(JSON.stringify([source.id,pkg.plugin.kind,pkg.plugin.id,pkg.plugin.version,pkg.manifest.sha256,source.payload.bindingId])).digest('hex');
    const requestHash=createHash('sha256').update(JSON.stringify([source.device_id,source.email,source.role,source.project_id,requestKey,pkg.manifest.sha256,instanceId])).digest('hex');
    const id=randomUUID(),message='Проверка файлов после установки ожидает моста. Модель и индекс не проверялись.';
    const inserted=await db.query<{id:string}>(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,state,payload,request_key,request_hash,message)
        VALUES($1,$2,$3,$4,$5,'inspect-installation','queued',$6,$7,$8,$9) ON CONFLICT(email,request_key) DO NOTHING RETURNING id`,
    [id,source.device_id,source.email,source.role,source.project_id,payload,requestKey,requestHash,message]);
    if(!inserted.rowCount){
        const existing=(await db.query<{request_hash:string;device_id:string}>('SELECT request_hash,device_id FROM bridge_jobs WHERE email=$1 AND request_key=$2',[source.email,requestKey])).rows[0];
        if(!existing||existing.request_hash!==requestHash||existing.device_id!==source.device_id)throw invalid();return false;
    }
    await db.query(`INSERT INTO bridge_job_requests(email,request_key,device_id,request_hash,job_id) VALUES($1,$2,$3,$4,$5)`,[source.email,requestKey,source.device_id,requestHash,id]);
    await recordDeviceOperation(db,{id,kind:'inspect-installation',email:source.email,project_id:source.project_id},'QUEUED',0,message);
    return true;
}
