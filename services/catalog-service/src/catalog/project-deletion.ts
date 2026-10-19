import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

/** Удаление с FK-cascade и единственная запись истории фиксируются одним соединением. */
export async function deleteProjectWithAudit(pool:Pool,idOrName:string,actor:string):Promise<boolean> {
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        const selected=await client.query<{id:string;name:string}>(
            `SELECT id,name FROM projects WHERE id=$1 OR (name=$1 AND $1 NOT LIKE 'prj-%')
             ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE`,[idOrName]);
        const project=selected.rows[0];
        if(!project){await client.query('COMMIT');return false;}
        const removed=await client.query('DELETE FROM projects WHERE id=$1',[project.id]);
        if(!removed.rowCount){await client.query('COMMIT');return false;}
        await client.query(
            `INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,
                bytes_done,bytes_total,started_at,finished_at,error,log,retries)
             VALUES($1,'DELETE',$2,'project',$2,$3,'SUCCEEDED',100,0,0,now(),now(),NULL,
                jsonb_build_array(jsonb_build_object('at',now(),'level','INFO','message',$4::text)),0)`,
            [`op-${randomUUID()}`,project.id,actor.trim()||'admin',`Удаление проекта «${project.name}»`]);
        await client.query('COMMIT');return true;
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
    finally{client.release();}
}
