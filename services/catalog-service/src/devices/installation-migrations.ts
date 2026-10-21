import type { CatalogMigration } from '../database/migrations';
import {SNAPSHOT_SCHEMA_SQL} from '../snapshots/snapshot-schema';

/** Метаданные локального плана не содержат исходники, полный diff или абсолютные пути. */
export const INSTALLATION_MIGRATIONS: readonly CatalogMigration[] = [{
    version: 1,
    name: 'reliable-local-installation',
    sql: `CREATE TABLE bridge_local_change_plans (
        id text PRIMARY KEY, device_id text NOT NULL REFERENCES bridge_devices(id),
        project_id text NOT NULL, email text NOT NULL, binding_id text NOT NULL,
        instance_id text NOT NULL, preparation_job_id text NOT NULL UNIQUE REFERENCES bridge_jobs(id),
        revision integer NOT NULL DEFAULT 1 CHECK(revision>0), digest text NOT NULL,
        summary jsonb NOT NULL, expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), applied_job_id text REFERENCES bridge_jobs(id));
        CREATE INDEX bridge_local_change_plans_scope ON bridge_local_change_plans(device_id,project_id,binding_id);
        CREATE TABLE bridge_instance_events (
        id text PRIMARY KEY REFERENCES bridge_jobs(id), device_id text NOT NULL REFERENCES bridge_devices(id),
        project_id text NOT NULL, email text NOT NULL, event text NOT NULL,
        instance_id text NOT NULL, binding_id text NOT NULL, previous_binding_id text,
        installations jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(installations)='array'), created_at timestamptz NOT NULL DEFAULT now());
        CREATE INDEX bridge_instance_events_scope ON bridge_instance_events(device_id,project_id,binding_id);`,
}, {
    version: 2,
    name: 'project-inventory-local-variants',
    sql: `ALTER TABLE bridge_local_change_plans ADD COLUMN purpose text NOT NULL DEFAULT 'repair'
        CHECK(purpose IN ('repair','adopt','restore-local'));
        ALTER TABLE bridge_local_change_plans ADD COLUMN source_id text;`,
}, {
    version: 3,
    name: 'runtime-artifacts',
    sql: `CREATE TABLE bridge_runtime_artifacts (sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
        compressed_bytes bigint NOT NULL CHECK(compressed_bytes>0 AND compressed_bytes<=268435456),
        unpacked_bytes bigint NOT NULL CHECK(unpacked_bytes>0 AND unpacked_bytes<=1073741824),
        files_count integer NOT NULL CHECK(files_count>0 AND files_count<=20000),
        imported_at timestamptz NOT NULL DEFAULT now());`,
}, {
    version: 4,
    name: 'durable-bridge-job-requests',
    sql: `CREATE TABLE bridge_job_requests (
        email text NOT NULL,request_key text NOT NULL,device_id text NOT NULL REFERENCES bridge_devices(id),
        request_hash text NOT NULL,job_id text NOT NULL REFERENCES bridge_jobs(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(email,request_key));
        CREATE INDEX bridge_job_requests_job ON bridge_job_requests(job_id);
        INSERT INTO bridge_job_requests(email,request_key,device_id,request_hash,job_id,created_at)
        SELECT email,request_key,device_id,request_hash,id,created_at FROM bridge_jobs;`,
}, {
    version:5,
    name:'immutable-project-snapshots',
    sql:SNAPSHOT_SCHEMA_SQL,
}];
