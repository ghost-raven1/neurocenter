import type {PoolClient} from 'pg';
import {DEVICE_CODEX_JOB} from '../../../shared/device-codex-inference.cjs';

/** A late receipt may settle failed uncertainty. Only the locked current Codex job owns its public state. */
export async function projectDeviceCodexOperation(db:Pick<PoolClient,'query'>,jobId:string):Promise<void>{
    await db.query(`INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
        SELECT 'bridge-'||job.id,'SYNC',job.project_id,'bridge',job.id,job.email,upper(job.state),
            CASE WHEN job.state='succeeded' THEN 100 ELSE 0 END,COALESCE(job.started_at,now()),now(),
            CASE WHEN job.state='failed' THEN 'Codex не завершил запрос. Автоматический повтор не выполняется.' ELSE NULL END,
            jsonb_build_array(jsonb_build_object('at',now(),'level',CASE WHEN job.state='failed' THEN 'ERROR' ELSE 'INFO' END,'message',
                CASE job.state WHEN 'succeeded' THEN 'Ответ Codex получен.' WHEN 'cancelled' THEN 'Запрос Codex отменён; сохранённые квитанции доступны.' ELSE 'Codex не завершил запрос. Автоматический повтор не выполняется.' END))
        FROM bridge_jobs job WHERE job.id=$1 AND job.kind=$2 AND job.state IN ('succeeded','failed','cancelled')
        ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=EXCLUDED.percent,
            started_at=COALESCE(operations.started_at,EXCLUDED.started_at),finished_at=EXCLUDED.finished_at,error=EXCLUDED.error,log=EXCLUDED.log
        WHERE operations.resource_type='bridge' AND operations.resource_id=EXCLUDED.resource_id
            AND operations.actor=EXCLUDED.actor AND operations.project_id IS NOT DISTINCT FROM EXCLUDED.project_id
            AND (operations.state IS DISTINCT FROM EXCLUDED.state OR operations.percent IS DISTINCT FROM EXCLUDED.percent
                OR operations.error IS DISTINCT FROM EXCLUDED.error OR operations.finished_at IS NULL)`,[jobId,DEVICE_CODEX_JOB]);
}
