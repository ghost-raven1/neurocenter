import type {PoolClient} from 'pg';

interface IJobOperation {id:string;kind:string;project_id:string|null;email:string;}

/** Проекция очереди записывается тем же клиентом, чтобы отзыв устройства мог быть одной транзакцией. */
export async function recordDeviceOperation(db:Pick<PoolClient,'query'>,job:IJobOperation,state:string,percent:number,message:string):Promise<void>{
    await db.query(
        `INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
        VALUES($1,$2,$3,'bridge',$4,$5,$6,$7,CASE WHEN $6='QUEUED' THEN NULL ELSE now() END,CASE WHEN $6 IN ('RUNNING','QUEUED') THEN NULL ELSE now() END,$8,$9)
        ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=GREATEST(operations.percent,EXCLUDED.percent),started_at=COALESCE(operations.started_at,EXCLUDED.started_at),finished_at=EXCLUDED.finished_at,error=EXCLUDED.error,log=EXCLUDED.log WHERE operations.state NOT IN ('SUCCEEDED','FAILED','CANCELLED') AND EXCLUDED.state<>'QUEUED'`,
        ['bridge-'+job.id,['install','apply-adopt-installation'].includes(job.kind)?'INSTALL':job.kind==='uninstall'?'DELETE':
            ['inspect-opencode-cli','inspect-installation','scan-opencode-models','scan-project-inventory','list-local-variants','prepare-adopt-installation','prepare-local-restore','prepare-mcp-configuration','get-mcp-configuration-status','prepare-opencode-provider','get-opencode-provider-status','probe-runtime'].includes(job.kind)?'VERIFY':'SYNC',job.project_id,job.id,job.email,state,percent,state==='FAILED'?message:null,
            JSON.stringify([{at:new Date().toISOString(),level:state==='FAILED'?'ERROR':'INFO',message}])],
    );
}

/** Инвалидация отправляется после фиксации данных; проекты перечитывают активные счётчики. */
export async function notifyDeviceOperations():Promise<void>{
    await fetch((process.env.API_GATEWAY_URL||'http://localhost:4000')+'/internal/events',{
        method:'POST',headers:{'Content-Type':'application/json','x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},
        body:JSON.stringify({sections:['operations','audit','projects']}),signal:AbortSignal.timeout(1500),
    }).catch(()=>undefined);
}
