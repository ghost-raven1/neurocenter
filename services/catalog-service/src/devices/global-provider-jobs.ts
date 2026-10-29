import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {OPENCODE_GLOBAL_PROVIDERS_READ_JOB,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB,OPENCODE_GLOBAL_PROVIDERS_CAPABILITY,normalizeGlobalProvidersRequest,normalizeGlobalProvidersPayload,normalizeGlobalProvidersResult,globalProvidersLimits} from '../../../shared/opencode-local-providers.cjs';
import {roleLevel} from '../access/access.model';
import {digest,type Device} from './device-store';
import type {Job,JobInput} from './device-job.model';
import type {DeviceCompletion} from './device-completion';
import {recordDeviceOperation} from './device-operations';

type GlobalProviderJob=Pick<Job,'kind'|'payload'|'project_id'|'device_id'|'email'|'role'>;
type Database=Pick<PoolClient,'query'>;
const kinds:readonly string[]=[OPENCODE_GLOBAL_PROVIDERS_READ_JOB,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB];
const minimum=(kind:string)=>kind===OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB?2:1;
const capability=(_kind:string)=>OPENCODE_GLOBAL_PROVIDERS_CAPABILITY;

/** Receipt-only identity never starts work or reads a result; current credentials must bind an already terminal lease. */
export async function globalProvidersReceiptIdentity(db:Database,token:unknown,id:string,lease:unknown):Promise<Device|undefined>{
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof lease!=='string'||!lease)return;
    return (await db.query<Device>(`SELECT device.* FROM bridge_devices device JOIN bridge_jobs job ON job.device_id=device.id
        WHERE device.token_hash=$1 AND job.id=$2 AND job.lease=$3 AND job.kind=ANY($4::text[]) AND job.email=device.email
        AND job.project_id IS NULL AND job.started_at IS NOT NULL AND job.state IN ('succeeded','failed','cancelled')`,
    [digest(token),id,lease,kinds])).rows[0];
}

/** Match revoke's device-before-job lock order, including replay and cancellation; other kinds are unaffected. */
export async function lockGlobalProvidersCompletionDevice(db:Database,deviceId:string,id:string,lease:string):Promise<void>{
    await db.query(`SELECT device.id FROM bridge_devices device JOIN bridge_jobs job ON job.device_id=device.id
        WHERE device.id=$1 AND job.id=$2 AND job.lease=$3 AND job.kind=ANY($4::text[]) FOR UPDATE OF device`,
    [deviceId,id,lease,kinds]);
}

/** Reject malformed browser input before any device lookup or accepted-request replay. */
export function assertGlobalProvidersInput(input:unknown):void{
    try{normalizeGlobalProvidersRequest(input);}
    catch{throw new BadRequestException({code:'global-providers-invalid-request',message:'Проверка провайдеров OpenCode принимает только компьютер, глобальную область и UUID ключа запроса.'});}
}

/** Read-only CLI observation belongs to an owned device, independent of a project or folder. */
export function assertGlobalProvidersJob(device:Device,job:GlobalProviderJob):void{
    if(!kinds.includes(job.kind))return;
    if(job.project_id!==null||job.device_id!==device.id||job.email!==device.email||roleLevel(job.role)<minimum(job.kind)||roleLevel(device.role)<minimum(job.kind)){
        throw new ForbiddenException({code:'global-providers-access-denied',message:'Проверка провайдеров OpenCode относится только к вашему компьютеру и действующей роли.'});
    }
    if(!Array.isArray(device.report.capabilities)||!device.report.capabilities.includes(capability(job.kind))){
        throw new ConflictException({code:'global-providers-upgrade-required',message:'Обновите мост, чтобы проверить пользовательский OpenCode.'});
    }
    try{
        if(normalizeGlobalProvidersPayload(job.payload,job.kind).deviceId!==device.id)throw Error();
    }
    catch{throw new ConflictException({code:'global-providers-invalid-context',message:'Контекст проверки провайдеров OpenCode повреждён или относится к другому компьютеру.'});}
}

/** A browser selects a computer and a request identity; it never selects a local executable. */
export function globalProvidersJobPayload(device:Device,input:JobInput,role:string):Record<string,unknown>|undefined{
    if(!kinds.includes(input.kind))return;
    assertGlobalProvidersInput(input);
    const payload=normalizeGlobalProvidersPayload({schemaVersion:1,scope:'global',deviceId:input.deviceId,...(input.kind===OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB?{expiresAt:new Date(Date.now()+globalProvidersLimits(process.env).sessionMs).toISOString()}:{})},input.kind);
    assertGlobalProvidersJob(device,{kind:input.kind,payload:{...payload},project_id:null,device_id:input.deviceId,email:device.email,role});
    return {...payload};
}

/** Membership rows and their projects stay locked through the first completion's commit. */
async function freshGlobalProvidersAccess(db:Database,job:GlobalProviderJob):Promise<Device>{
    const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR SHARE',[job.device_id,job.email])).rows[0];
    const user=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[job.email])).rows[0];
    const grants=await db.query<{role:string}>(`SELECT member.role FROM project_members member JOIN projects project ON project.id=member.project_id
        WHERE lower(member.principal_name)=$1 FOR SHARE OF member,project`,[job.email]);
    const allowed=(role:string)=>roleLevel(role)>=minimum(job.kind)&&(role==='Главный админ'?user?.is_main_admin:grants.rows.some(grant=>grant.role===role));
    if(!device||!user?.enabled||!allowed(job.role)||!allowed(device.role))throw new ForbiddenException({code:'global-providers-access-denied',message:'Доступ к проверке OpenCode на компьютере отозван.'});
    assertGlobalProvidersJob(device,job);return device;
}

/** Called under the enqueue device lock, after exact receipt lookup and fresh feature checks. */
export async function assertGlobalProvidersAdmission(db:Database,job:GlobalProviderJob):Promise<void>{
    if(kinds.includes(job.kind))await freshGlobalProvidersAccess(db,job);
}

/** The final read fences a cancelled lease, revoked role and changed device after async checks. */
export async function assertGlobalProvidersAuthority(db:Database,device:Device,job:Job,requestToken?:string):Promise<void>{
    if(!kinds.includes(job.kind))return;
    if(requestToken!==undefined&&(typeof requestToken!=='string'||!/^[a-f0-9]{64}$/.test(requestToken)))throw new ForbiddenException('Авторизация компьютера не подтверждена.');
    // One statement observes device, lease, account and both role grants at the same database snapshot.
    // Pool-level FOR SHARE reads would release each lock before the next read and leave a revocation gap.
    const roleAllowed=(role:string)=>`(${role} IN ('Главный админ','Админ проекта','Разработчик'${minimum(job.kind)===1?",'Наблюдатель'":''}) AND
        CASE WHEN ${role}='Главный админ' THEN account.is_main_admin ELSE EXISTS (
            SELECT 1 FROM project_members member JOIN projects project ON project.id=member.project_id
            WHERE lower(member.principal_name)=job.email AND member.role=${role}) END)`;
    const selected=await db.query<{authorized:boolean}>(`SELECT account.enabled AND ${roleAllowed('job.role')} AND ${roleAllowed('device.role')} AS authorized
        FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id
        LEFT JOIN platform_users account ON account.email=job.email
        WHERE job.id=$1 AND job.device_id=$2 AND job.email=$3 AND job.role=$4 AND job.lease=$5
        AND job.kind=$6 AND job.project_id IS NULL AND job.state='running' AND job.lease_until>clock_timestamp() AND job.payload=$7::jsonb
        AND device.email=$3 AND device.role=$8 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND jsonb_typeof(device.report->'capabilities')='array' AND device.report->'capabilities' ? $9 AND ($10::text IS NULL OR device.token_hash=$10)
`,
    [job.id,device.id,job.email,job.role,job.lease,job.kind,JSON.stringify(job.payload),device.role,capability(job.kind),requestToken===undefined?null:digest(requestToken)]);
    if(!selected.rows.length)throw new ConflictException({code:'global-providers-authority-changed',message:'Компьютер или задание проверки провайдеров OpenCode изменились.'});
    if(!selected.rows[0].authorized)throw new ForbiddenException({code:'global-providers-access-denied',message:'Доступ к проверке OpenCode на компьютере отозван.'});
}

/** Static messages and strict receipts prevent local process output from entering shared history. */
export async function completeGlobalProviders(db:Database,job:GlobalProviderJob&{id:string;state:string;result:unknown},input:DeviceCompletion){
    if(!kinds.includes(job.kind))return;
    if(job.state==='cancelled')return {ok:true as const,repeated:true,cancelled:true};
    let result:Record<string,unknown>;
    try{
        if(job.project_id!==null||normalizeGlobalProvidersPayload(job.payload,job.kind).deviceId!==job.device_id)throw Error();
        // Existing worker/transport failures have no observation; never invent a timestamp or missing CLI.
        if(input.state==='failed'&&Object.keys(input.result).length===0)result={};
        else{
            const observed=normalizeGlobalProvidersResult(input.result,{deviceId:job.device_id,jobId:job.id,kind:job.kind,expiresAt:normalizeGlobalProvidersPayload(job.payload,job.kind).expiresAt});
            if((input.state==='succeeded')!==(observed.status!=='failed'))throw Error();
            result={...observed};
        }
    }catch{throw new ConflictException({code:'global-providers-invalid-receipt',message:'Квитанция проверки провайдеров OpenCode содержит неподдерживаемые данные или другой компьютер.'});}
    if(['succeeded','failed'].includes(job.state)){
        if(job.state!==input.state||!isDeepStrictEqual(job.result??{},result))throw new ConflictException({code:'global-providers-receipt-conflict',message:'Проверка провайдеров OpenCode уже завершена с другим результатом.'});
        return {ok:true as const,repeated:true};
    }
    if(!['running','reconciling'].includes(job.state))throw new ConflictException({code:'global-providers-not-running',message:'Проверка провайдеров OpenCode не была принята мостом.'});
    await freshGlobalProvidersAccess(db,job);
    const message=result.status==='opened'?'Локальное окно настройки OpenCode открыто. Сохранение проверяется отдельно.':result.status==='checked'?'Состояние глобальных провайдеров OpenCode прочитано.':result.status==='partial'?'Часть локальной настройки не подтверждена. Проверьте компьютер.':'Локальная настройка OpenCode не подтверждена.';
    const percent=input.state==='succeeded'?100:0;
    await db.query('UPDATE bridge_jobs SET state=$2,percent=$3,message=$4,result=$5,updated_at=now() WHERE id=$1',[job.id,input.state,percent,message,result]);
    await recordDeviceOperation(db,job,input.state.toUpperCase(),percent,message);
    return {ok:true as const,repeated:false};
}

/** A private window outlives its opening ACK; every operation obtains a fresh device/account/role permit. */
export async function authorizeGlobalProvidersSession(store:{pool:Database},device:Device,input:unknown,requireEnabled:()=>Promise<unknown>,bearer:string){
    if(typeof bearer!=='string'||!/^[a-f0-9]{64}$/.test(bearer))throw new ForbiddenException('Авторизация компьютера не подтверждена.');
    const body=input as {jobId?:unknown}|null;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.jobId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(body.jobId))throw new BadRequestException('Разрешение принимает только сохранённое задание открытия.');
    const job=(await store.pool.query<Job>(`SELECT * FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND kind=$4 AND project_id IS NULL AND state IN ('running','succeeded')`,[body.jobId,device.id,device.email,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB])).rows[0];
    if(!job)throw new ConflictException('Локальное окно не открыто этим компьютером.');
    const payload=normalizeGlobalProvidersPayload(job.payload,job.kind);
    await freshGlobalProvidersAccess(store.pool,job);await requireEnabled();
    const selected=await store.pool.query<{authorized:boolean}>(`SELECT account.enabled AND
        (CASE WHEN job.role='Главный админ' THEN account.is_main_admin ELSE EXISTS(SELECT 1 FROM project_members member JOIN projects project ON project.id=member.project_id WHERE lower(member.principal_name)=job.email AND member.role=job.role AND member.role IN ('Разработчик','Админ проекта')) END)
        AND (CASE WHEN device.role='Главный админ' THEN account.is_main_admin ELSE EXISTS(SELECT 1 FROM project_members member JOIN projects project ON project.id=member.project_id WHERE lower(member.principal_name)=job.email AND member.role=device.role AND member.role IN ('Разработчик','Админ проекта')) END) AS authorized
        FROM bridge_jobs job JOIN bridge_devices device ON device.id=job.device_id LEFT JOIN platform_users account ON account.email=job.email
        WHERE job.id=$1 AND device.id=$2 AND job.email=$3 AND job.kind=$4 AND job.project_id IS NULL AND job.state IN ('running','succeeded') AND job.payload=$5::jsonb
        AND (job.payload->>'expiresAt')::timestamptz>clock_timestamp() AND device.email=job.email AND device.role=$6 AND NOT device.revoked AND device.expires_at>clock_timestamp()
        AND jsonb_typeof(device.report->'capabilities')='array' AND device.report->'capabilities' ? $7 AND device.token_hash=$8`,
    [job.id,device.id,job.email,job.kind,JSON.stringify(payload),device.role,OPENCODE_GLOBAL_PROVIDERS_CAPABILITY,digest(bearer)]);
    if(!selected.rows[0]?.authorized)throw new ForbiddenException('Доступ к локальному окну истёк или отозван. Откройте настройку заново.');
    return{ok:true as const,expiresAt:payload.expiresAt!};
}
