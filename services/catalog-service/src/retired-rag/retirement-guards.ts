import {ConflictException} from '@nestjs/common';
import type {PoolClient} from 'pg';

type Db=Pick<PoolClient,'query'>;
const checks=[
    ['bridge_jobs',"state IN ('queued','running','reconciling')",'Есть незавершённое задание компьютера.'],
    ['project_rag_sync_intents',"state IN ('pending','uncertain')",'Синхронизация RAG ещё не подтверждена.'],
    ['project_reindex_plans',"state IN ('preparing','needs_input','building','ready','cancelling')",'Есть незавершённая переиндексация.'],
    ['project_snapshots',"status IN ('UPLOADING','VERIFYING')",'Снимок проекта ещё создаётся или проверяется.'],
] as const;

/** Схемы фич запускаются независимо; отсутствие таблицы означает, что её refs ещё не существуют. */
export async function retirementBlockers(db:Db,projectId:string,includeGrants=true):Promise<string[]>{
    const blockers:string[]=[];
    for(const [table,condition,message] of checks){
        if(!(await db.query('SELECT to_regclass($1) AS name',[table])).rows[0]?.name)continue;
        if((await db.query(`SELECT 1 FROM ${table} WHERE project_id=$1 AND ${condition} LIMIT 1`,[projectId])).rows.length)blockers.push(message);
    }
    if(includeGrants&&(await db.query("SELECT to_regclass('bridge_hosted_rag_grants') AS name")).rows[0]?.name
        &&(await db.query('SELECT 1 FROM bridge_hosted_rag_grants WHERE project_id=$1 AND revoked_at IS NULL LIMIT 1',[projectId])).rows.length)blockers.push('Есть действующее разрешение локального RAG.');
    return blockers;
}
export async function requireRetirementIdle(db:Db,projectId:string):Promise<void>{const blockers=await retirementBlockers(db,projectId,false);if(blockers.length)throw new ConflictException(blockers.join(' '));}
