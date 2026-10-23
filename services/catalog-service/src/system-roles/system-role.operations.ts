import type { PoolClient } from 'pg';
import type { RoleRunRow,RoleRunState } from './system-role.types';
import type {TOperationState} from '../catalog/dto';

/** Both a stored feed row and a command receipt describe the owner's actual current run. */
export function projectRoleState(state:RoleRunState):TOperationState{
    if(state==='queued')return 'QUEUED';
    if(['running','awaiting_review','applying'].includes(state))return 'RUNNING';
    return state==='succeeded'?'SUCCEEDED':state==='cancelled'?'CANCELLED':'FAILED';
}

/** The owner writes its safe feed projection in the same transaction as the authoritative state. */
export async function projectRoleOperation(db: Pick<PoolClient, 'query'>, row: RoleRunRow): Promise<void> {
    const active = ['queued', 'running', 'awaiting_review', 'applying'].includes(row.state);
    const state = projectRoleState(row.state);
    await db.query(`INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
        VALUES($1,'MODEL',$2,'system-role',$3,$4,$5,$6,CASE WHEN $5='QUEUED' THEN NULL ELSE now() END,CASE WHEN $7 THEN NULL ELSE now() END,$8,$9::jsonb)
        ON CONFLICT(operation_id) DO UPDATE SET state=EXCLUDED.state,percent=EXCLUDED.percent,started_at=COALESCE(operations.started_at,EXCLUDED.started_at),
            finished_at=EXCLUDED.finished_at,error=EXCLUDED.error,log=EXCLUDED.log`,
    ['system-role-' + row.id, row.project_id, row.id, row.actor, state, row.state === 'queued' ? 0 : row.state === 'awaiting_review' ? 80 : active ? 40 : 100,
        active, state === 'FAILED' ? row.message : null, JSON.stringify(row.steps.map(step => ({ at: step.at, level: state === 'FAILED' ? 'WARN' : 'INFO', message: step.message })))]);
}
export async function notifyRoleOperations(): Promise<void> {
    await fetch((process.env.API_GATEWAY_URL || 'http://localhost:4000') + '/internal/events', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '' },
        body: JSON.stringify({ sections: ['operations', 'audit', 'projects'] }), signal: AbortSignal.timeout(1500), redirect: 'error' }).catch(() => undefined);
}
