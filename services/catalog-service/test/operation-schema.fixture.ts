import type {Pool} from 'pg';

/** Minimal real journal schema for executor integration fixtures that deliberately omit CatalogDb startup. */
export async function operationSchema(pool:Pool):Promise<void>{
    await pool.query(`CREATE TABLE operations(operation_id text PRIMARY KEY,type text,project_id text,resource_type text,resource_id text,actor text,state text,percent integer,
        bytes_done bigint DEFAULT 0,bytes_total bigint DEFAULT 0,started_at timestamptz,finished_at timestamptz,error text,log jsonb,retries integer DEFAULT 0,created_at timestamptz DEFAULT now())`);
}
