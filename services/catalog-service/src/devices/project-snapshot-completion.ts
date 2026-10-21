import {ConflictException} from '@nestjs/common';
import type {Pool,PoolClient} from 'pg';
import {transitionDeviceJobs} from './device-job-transition';
import {SNAPSHOT_JOB_KIND} from './project-snapshot-jobs';
interface SnapshotJob {kind:string;id:string;project_id:string|null;device_id:string;email:string;payload:Record<string,unknown>}

/** A bridge confirms upload only; the independent SDK verifier owns VERIFIED. */
export async function assertSnapshotCompletion(client:PoolClient,job:SnapshotJob,result:Record<string,unknown>,failed:boolean):Promise<void>{
 if(job.kind!==SNAPSHOT_JOB_KIND)return;
 if(failed){if(Object.keys(result).length)throw new ConflictException('Ошибка передачи не должна содержать локальные данные.');return;}
 const keys=['projectId','bindingId','snapshotId','manifestSha256','status','bytes','fileCount','tableCount'];
 if(Object.keys(result).length!==keys.length||Object.keys(result).some(key=>!keys.includes(key))||result.status!=='UPLOADED'||result.projectId!==job.project_id||result.bindingId!==job.payload.bindingId||result.snapshotId!==job.payload.snapshotId)throw new ConflictException('Квитанция передачи относится к другому снимку или папке.');
 const row=(await client.query(`SELECT manifest_sha256,total_bytes,jsonb_array_length(manifest->'files') AS files,jsonb_array_length(manifest->'tables') AS tables
  FROM project_snapshots WHERE id::text=$1 AND project_id=$2 AND device_id=$3 AND email=$4 AND binding_id=$5 AND job_id=$6 AND upload_completed_at IS NOT NULL`,[job.payload.snapshotId,job.project_id,job.device_id,job.email,job.payload.bindingId,job.id])).rows[0];
 if(!row||result.manifestSha256!==row.manifest_sha256||result.bytes!==Number(row.total_bytes)||result.fileCount!==row.files||result.tableCount!==row.tables)throw new ConflictException('Сервер ещё не принял полную опись и все блоки этого снимка.');
}
/** Capturing reads files only: an expired unpublished capture can fail without uncertain local writes. */
export async function reconcileSnapshotJobs(pool:Pool):Promise<void>{
 const message='Все блоки снимка приняты сервером. Проверка LanceDB выполняется отдельно.';
 await transitionDeviceJobs(pool,`UPDATE bridge_jobs j SET state='succeeded',percent=100,message=$1,
  result=jsonb_build_object('projectId',s.project_id,'bindingId',s.binding_id,'snapshotId',s.id::text,'manifestSha256',s.manifest_sha256,'status','UPLOADED','bytes',s.total_bytes,'fileCount',jsonb_array_length(s.manifest->'files'),'tableCount',jsonb_array_length(s.manifest->'tables')),updated_at=now()
  FROM project_snapshots s WHERE j.kind='publish-project-snapshot' AND j.state IN ('running','reconciling') AND j.lease_until<=now()
  AND s.id::text=j.payload->>'snapshotId' AND s.project_id=j.project_id AND s.email=j.email AND s.device_id=j.device_id AND s.binding_id=j.payload->>'bindingId' AND s.job_id=j.id AND s.upload_completed_at IS NOT NULL RETURNING j.*`,[message],{state:'SUCCEEDED',percent:100,message});
 const failed='Передача снимка прервалась до подтверждения. Создайте снимок заново; принятые блоки будут переиспользованы.';
 await transitionDeviceJobs(pool,`UPDATE bridge_jobs AS expired SET state='failed',result='{}'::jsonb,message=$1,updated_at=now()
  WHERE kind='publish-project-snapshot' AND state IN ('running','reconciling') AND lease_until<=now() RETURNING *`,[failed],{state:'FAILED',message:failed});
}
