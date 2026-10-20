import {ConflictException,NotFoundException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {UploadIntent,UploadRow} from './source-upload.model';

/** Actor ownership, immutable request identities and source retention share the build transaction. */
export class SourceUploadRepository{
 constructor(readonly pool:Pool){}
 async setup(){await this.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(72465402)');await client.query(`
  ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS source_upload_auth_epoch uuid NOT NULL DEFAULT gen_random_uuid();
  CREATE OR REPLACE FUNCTION rotate_source_upload_auth_epoch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
   IF OLD.is_main_admin IS DISTINCT FROM NEW.is_main_admin OR OLD.enabled IS DISTINCT FROM NEW.enabled THEN NEW.source_upload_auth_epoch=gen_random_uuid(); END IF;
   RETURN NEW; END$$;
  DROP TRIGGER IF EXISTS source_upload_access_epoch ON platform_users;
  CREATE TRIGGER source_upload_access_epoch BEFORE UPDATE OF is_main_admin,enabled ON platform_users FOR EACH ROW EXECUTE FUNCTION rotate_source_upload_auth_epoch();
  CREATE TABLE IF NOT EXISTS tool_source_uploads(
  id uuid PRIMARY KEY,actor text NOT NULL,request_key uuid NOT NULL,request_hash text NOT NULL,name text NOT NULL,
  sha256 text NOT NULL CHECK(sha256~'^[a-f0-9]{64}$'),bytes bigint NOT NULL CHECK(bytes>0 AND bytes<=268435456),
  format text NOT NULL CHECK(format IN ('zip','tar.gz','file')),state text NOT NULL CHECK(state IN ('WAITING','UPLOADING','READY','CANCELLED')),
  auth_epoch text NOT NULL,lease_token uuid,metadata jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  UNIQUE(actor,request_key));
  ALTER TABLE tool_source_uploads ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
  ALTER TABLE tool_source_uploads ADD COLUMN IF NOT EXISTS cleanup_checked_at timestamptz;
  CREATE INDEX IF NOT EXISTS tool_source_upload_expiry ON tool_source_uploads(expires_at);`);});}
 async create(actor:string,epoch:string,input:UploadIntent):Promise<UploadRow>{
  const fingerprint=createHash('sha256').update(JSON.stringify([input.name,input.sha256,input.bytes])).digest('hex'),format=/\.(?:tar\.gz|tgz)$/i.test(input.name)?'tar.gz':/\.zip$/i.test(input.name)?'zip':'file';
  const {rows}=await this.pool.query<UploadRow>(`INSERT INTO tool_source_uploads(id,actor,request_key,request_hash,name,sha256,bytes,format,state,auth_epoch)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'WAITING',$9) ON CONFLICT(actor,request_key) DO UPDATE SET request_key=EXCLUDED.request_key RETURNING *`,[randomUUID(),actor,input.requestKey,fingerprint,input.name,input.sha256,input.bytes,format,epoch]);
  if(rows[0].request_hash!==fingerprint)throw new ConflictException('UUID загрузки уже принадлежит другому файлу.');
  return rows[0];
 }
 async get(actor:string,id:string,client:Pick<Pool,'query'>=this.pool,lock=false):Promise<UploadRow>{
  const {rows}=await client.query<UploadRow>('SELECT * FROM tool_source_uploads WHERE actor=$1 AND id=$2'+(lock?' FOR UPDATE':''),[actor,id]);
  if(!rows[0])throw new NotFoundException('Загрузка не найдена.');return rows[0];
 }
 async lookup(actor:string,key:string):Promise<UploadRow>{
  const {rows}=await this.pool.query<UploadRow>('SELECT * FROM tool_source_uploads WHERE actor=$1 AND request_key=$2',[actor,key]);
  if(!rows[0])throw new NotFoundException('Загрузка ещё не создана.');return rows[0];
 }
 async referenced(client:Pick<Pool,'query'>,id:string):Promise<boolean>{
  const table=await client.query<{present:boolean}>("SELECT to_regclass('tool_build_jobs') IS NOT NULL AS present");
  if(!table.rows[0]?.present)return false;
  return !!(await client.query("SELECT 1 FROM tool_build_jobs WHERE config->'source'->>'uploadId'=$1 LIMIT 1",[id])).rowCount;
 }
 async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect();try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
 }
}
