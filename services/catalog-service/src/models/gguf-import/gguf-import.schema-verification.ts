import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../../database/schema-catalog';

/** Named facts allow readiness to reject a partial GGUF migration without mutating storage. */
export const GGUF_IMPORT_SCHEMA_CONTRACT=[
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_bytes_check","definition":{"type":"c","validated":true,"definition":"CHECK (bytes > 0 AND bytes <= '9007199254740991'::bigint)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_check","definition":{"type":"c","validated":true,"definition":"CHECK ((state <> ALL (ARRAY['READY'::text, 'ACCEPTED'::text])) OR sha256 IS NOT NULL AND metadata IS NOT NULL)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_check1","definition":{"type":"c","validated":true,"definition":"CHECK (state <> 'ACCEPTED'::text OR model_id IS NOT NULL AND accept_hash IS NOT NULL)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_expected_sha256_check","definition":{"type":"c","validated":true,"definition":"CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'::text)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_limits_check","definition":{"type":"c","validated":true,"definition":"CHECK (jsonb_typeof(limits) = 'object'::text)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_sha256_check","definition":{"type":"c","validated":true,"definition":"CHECK (sha256 ~ '^[a-f0-9]{64}$'::text)"}},
 {"kind":"constraint","id":"model_gguf_uploads.model_gguf_uploads_state_check","definition":{"type":"c","validated":true,"definition":"CHECK (state = ANY (ARRAY['WAITING'::text, 'UPLOADING'::text, 'READY'::text, 'CANCELLED'::text, 'ACCEPTED'::text]))"}},
 {kind:'table',id:'model_gguf_uploads',definition:{kind:'r',persistence:'p'}},
 ...(['id','actor','request_key','request_hash','file_name','bytes','expected_sha256','sha256','state','auth_epoch','lease_token','metadata','limits','model_id','accept_hash','created_at','updated_at','expires_at','cleaned_at'] as const).map((name,index)=>({kind:'column',id:'model_gguf_uploads.'+name,definition:{type:['uuid','text','uuid','text','text','bigint','text','text','text','text','uuid','jsonb','jsonb','text','text','timestamp with time zone','timestamp with time zone','timestamp with time zone','timestamp with time zone'][index],notNull:!['expected_sha256','sha256','lease_token','metadata','model_id','accept_hash','cleaned_at'].includes(name),default:['created_at','updated_at'].includes(name)?'now()':null}})),
 {kind:'constraint',id:'model_gguf_uploads.model_gguf_uploads_pkey',definition:{type:'p',validated:true,definition:'PRIMARY KEY (id)'}},
 {kind:'constraint',id:'model_gguf_uploads.model_gguf_uploads_actor_request_key_key',definition:{type:'u',validated:true,definition:'UNIQUE (actor, request_key)'}},
 {kind:'constraint',id:'model_gguf_uploads.model_gguf_uploads_model_id_key',definition:{type:'u',validated:true,definition:'UNIQUE (model_id)'}},
 {kind:'constraint',id:'model_gguf_uploads.model_gguf_uploads_model_id_fkey',definition:{type:'f',validated:true,definition:'FOREIGN KEY (model_id) REFERENCES model_catalog(id)'}},
];
const issues=`WITH expected AS (SELECT * FROM jsonb_to_recordset($gguf_import$${JSON.stringify(GGUF_IMPORT_SCHEMA_CONTRACT)}$gguf_import$::jsonb) AS objects(kind text,id text,definition jsonb)),actual AS (${CATALOG_SCHEMA_FACTS_SQL}) SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id) WHERE actual.definition IS DISTINCT FROM expected.definition`;
export const GGUF_IMPORT_SCHEMA_ASSERT_SQL=`DO $verify_gguf_import$ DECLARE missing text;BEGIN SELECT string_agg(issue,', ') INTO missing FROM (${issues}) issues; IF missing IS NOT NULL THEN RAISE EXCEPTION 'GGUF import schema is incomplete: %',missing;END IF;END $verify_gguf_import$;`;
export async function assertGgufImportSchema(db:Pick<Pool,'query'>):Promise<void>{if((await db.query(issues)).rows.length)throw new Error('Схема импорта GGUF не готова.');}
