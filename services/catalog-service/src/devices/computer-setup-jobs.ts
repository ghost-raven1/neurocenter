import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {OPENCODE_CLI_INSPECT_JOB,OPENCODE_CLI_CAPABILITY,normalizeOpenCodeCliRequest,normalizeOpenCodeCliPayload,normalizeOpenCodeCliResult} from '../../../shared/computer-setup.cjs';
import {roleLevel} from '../access/access.model';
import {digest,type Device} from './device-store';
import type {Job,JobInput} from './device-job.model';
import type {DeviceCompletion} from './device-completion';
import {recordDeviceOperation} from './device-operations';

type ComputerJob=Pick<Job,'kind'|'payload'|'project_id'|'device_id'|'email'|'role'>;
type Database=Pick<PoolClient,'query'>;

/** Receipt-only identity never starts work or reads a result; current credentials must bind an already terminal lease. */
export async function computerSetupReceiptIdentity(db:Database,token:unknown,id:string,lease:unknown):Promise<Device|undefined>{
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof lease!=='string'||!lease)return;
    return (await db.query<Device>(`SELECT device.* FROM bridge_devices device JOIN bridge_jobs job ON job.device_id=device.id
        WHERE device.token_hash=$1 AND job.id=$2 AND job.lease=$3 AND job.kind=$4 AND job.email=device.email
        AND job.project_id IS NULL AND job.started_at IS NOT NULL AND job.state IN ('succeeded','failed','cancelled')`,
    [digest(token),id,lease,OPENCODE_CLI_INSPECT_JOB])).rows[0];
}

/** Match revoke's device-before-job lock order, including replay and cancellation; other kinds are unaffected. */
export async function lockComputerSetupCompletionDevice(db:Database,deviceId:string,id:string,lease:string):Promise<void>{
    await db.query(`SELECT device.id FROM bridge_devices device JOIN bridge_jobs job ON job.device_id=device.id
        WHERE device.id=$1 AND job.id=$2 AND job.lease=$3 AND job.kind=$4 FOR UPDATE OF device`,
    [deviceId,id,lease,OPENCODE_CLI_INSPECT_JOB]);
}

/** Reject malformed browser input before any device lookup or accepted-request replay. */
export function assertComputerSetupInput(input:unknown):void{
    try{normalizeOpenCodeCliRequest(input);}
    catch{throw new BadRequestException({code:'computer-setup-invalid-request',message:'Проверка OpenCode принимает только компьютер, глобальную область и UUID ключа запроса.'});}
}

/** Read-only CLI observation belongs to an owned device, independent of a project or folder. */
export function assertComputerSetupJob(device:Device,job:ComputerJob):void{
    if(job.kind!==OPENCODE_CLI_INSPECT_JOB)return;
    if(job.project_id!==null||job.device_id!==device.id||job.email!==device.email||roleLevel(job.role)<1||roleLevel(device.role)<1){
        throw new ForbiddenException({code:'computer-setup-access-denied',message:'Проверка OpenCode относится только к вашему компьютеру и действующей роли.'});
    }
    if(!Array.isArray(device.report.capabilities)||!device.report.capabilities.includes(OPENCODE_CLI_CAPABILITY)){
        throw new ConflictException({code:'computer-setup-upgrade-required',message:'Обновите мост, чтобы проверить пользовательский OpenCode.'});
    }
    try{if(normalizeOpenCodeCliPayload(job.payload).deviceId!==device.id)throw Error();}
    catch{throw new ConflictException({code:'computer-setup-invalid-context',message:'Контекст проверки OpenCode повреждён или относится к другому компьютеру.'});}
}

/** A browser selects a computer and a request identity; it never selects a local executable. */
export function computerSetupJobPayload(device:Device,input:JobInput,role:string):Record<string,unknown>|undefined{
    if(input.kind!==OPENCODE_CLI_INSPECT_JOB)return;
    assertComputerSetupInput(input);
    const payload=normalizeOpenCodeCliPayload({schemaVersion:1,scope:'global',deviceId:input.deviceId});
    assertComputerSetupJob(device,{kind:input.kind,payload:{...payload},project_id:null,device_id:input.deviceId,email:device.email,role});
    return {...payload};
}

/** Membership rows and their projects stay locked through the first completion's commit. */
async function freshComputerAccess(db:Database,job:ComputerJob):Promise<Device>{
    const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[job.device_id,job.email])).rows[0];
    const user=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[job.email])).rows[0];
    const grants=await db.query<{role:string}>(`SELECT member.role FROM project_members member JOIN projects project ON project.id=member.project_id
        WHERE lower(member.principal_name)=$1 FOR SHARE OF member,project`,[job.email]);
    const allowed=(role:string)=>roleLevel(role)>0&&(role==='Главный админ'?user?.is_main_admin:grants.rows.some(grant=>grant.role===role));
    if(!device||!user?.enabled||!allowed(job.role)||!allowed(device.role))throw new ForbiddenException({code:'computer-setup-access-denied',message:'Доступ к проверке OpenCode на компьютере отозван.'});
    assertComputerSetupJob(device,job);return device;
}

/** Called under the enqueue device lock, after exact receipt lookup and fresh feature checks. */
export async function assertComputerSetupAdmission(db:Database,job:ComputerJob):Promise<void>{
    if(job.kind===OPENCODE_CLI_INSPECT_JOB)await freshComputerAccess(db,job);
}

/** The final read fences a cancelled lease, revoked role and changed device after async checks. */
export async function assertComputerSetupAuthority(db:Database,device:Device,job:Job):Promise<void>{
    if(job.kind!==OPENCODE_CLI_INSPECT_JOB)return;
    // One statement observes device, lease, account and both role grants at the same database snapshot.
    // Pool-level FOR SHARE reads would release each lock before the next read and leave a revocation gap.
    const roleAllowed=(role:string)=>`(${role} IN ('Главный админ','Админ проекта','Разработчик','Наблюдатель') AND
        CASE WHEN ${role}='Главный админ' THEN account.is_main_admin ELSE EXISTS (
            SELECT 1 FROM project_members member JOIN projects project ON project.id=member.project_id
            WHERE lower(member.principal_name)=job.email AND member.role=${role}) END)`;
    const selected=await db.query<{authorized:boolean}>(`SELECT account.enabled AND ${roleAllowed('job.role')} AND ${roleAllowed('device.role')} AS authorized
        FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
        LEFT JOIN platform_users account ON account.email=job.email
        WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.lease=$5
        AND job.kind=$6 AND job.project_id IS NULL AND job.state='running' AND job.lease_until>clock_timestamp() AND job.payload=$7::jsonb
        AND device.email=$3 AND device.role=$8 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND jsonb_typeof(device.report->'capabilities')='array' AND device.report->'capabilities' ? $9`,
    [job.id,device.id,job.email,job.role,job.lease,OPENCODE_CLI_INSPECT_JOB,JSON.stringify(job.payload),device.role,OPENCODE_CLI_CAPABILITY]);
    if(!selected.rows.length)throw new ConflictException({code:'computer-setup-authority-changed',message:'Компьютер или задание проверки OpenCode изменились.'});
    if(!selected.rows[0].authorized)throw new ForbiddenException({code:'computer-setup-access-denied',message:'Доступ к проверке OpenCode на компьютере отозван.'});
}

/** Static messages and strict receipts prevent local process output from entering shared history. */
export async function completeComputerSetup(db:Database,job:ComputerJob&{id:string;state:string;result:unknown},input:DeviceCompletion){
    if(job.kind!==OPENCODE_CLI_INSPECT_JOB)return;
    if(job.state==='cancelled')return {ok:true as const,repeated:true,cancelled:true};
    let result:Record<string,unknown>;
    try{
        if(job.project_id!==null||normalizeOpenCodeCliPayload(job.payload).deviceId!==job.device_id)throw Error();
        // Existing worker/transport failures have no observation; never invent a timestamp or missing CLI.
        if(input.state==='failed'&&Object.keys(input.result).length===0)result={};
        else{
            const observed=normalizeOpenCodeCliResult(input.result,{deviceId:job.device_id,jobId:job.id});
            if((input.state==='succeeded')!==['installed','missing'].includes(observed.status))throw Error();
            result={...observed};
        }
    }catch{throw new ConflictException({code:'computer-setup-invalid-receipt',message:'Квитанция проверки OpenCode содержит неподдерживаемые данные или другой компьютер.'});}
    if(['succeeded','failed'].includes(job.state)){
        if(job.state!==input.state||!isDeepStrictEqual(job.result??{},result))throw new ConflictException({code:'computer-setup-receipt-conflict',message:'Проверка OpenCode уже завершена с другим результатом.'});
        return {ok:true as const,repeated:true};
    }
    if(!['running','reconciling'].includes(job.state))throw new ConflictException({code:'computer-setup-not-running',message:'Проверка OpenCode не была принята мостом.'});
    await freshComputerAccess(db,job);
    const message=result.status==='installed'?'Пользовательский OpenCode найден.':result.status==='missing'?'Пользовательский OpenCode не найден.'
        :result.status==='timed-out'?'Проверка OpenCode превысила срок. Повторите проверку.':'Проверка OpenCode не завершена. Проверьте компьютер и повторите действие.';
    const percent=input.state==='succeeded'?100:0;
    await db.query('UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5,updated_at=now() WHERE id=$1',[job.id,input.state,percent,message,result]);
    await recordDeviceOperation(db,job,input.state.toUpperCase(),percent,message);
    return {ok:true as const,repeated:false};
}
