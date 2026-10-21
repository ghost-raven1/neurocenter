import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ConflictException } from '@nestjs/common';
import type { IOpenCodeModelCandidate, IOpenCodeModelScan } from '../../../shared/opencode-model-scan.cjs';
import { nextModelRevision, saveModelVersion, type IModelRow } from './model-history';
import { validateModelCreate } from './model-validation';
import { remoteModelBaseUrl } from './remote-model-validation';
import { remoteModelOptions, remoteModelTimeout } from './remote-model-options';
import { canStoreModelCredential, sealModelCredential } from './remote-model-secret';
import { RemoteConnectionRepository } from './remote-connection.repository';
import { securityEvent } from '../access/security-events';
import {resolveOpenCodeIdentity,saveOpenCodeIdentity} from './opencode-model-identity';
export {openCodeIdentity} from './opencode-model-identity';

export interface OpenCodeSyncSettings { revision: number; enabled: boolean; transferCredentials: boolean }
export const defaultOpenCodeSyncSettings: OpenCodeSyncSettings = { revision: 0, enabled: true, transferCredentials: false };
export function openCodeCardMetadata(candidate:IOpenCodeModelCandidate,scope:'global'|'project'):{name:string;description:string}{
    const source=scope==='global'?'общая конфигурация':'конфигурация проекта',options=remoteModelOptions(candidate.options);
    const parameters=Object.entries(options).map(([key,value])=>`${({contextWindow:'Контекст',temperature:'Температура',topP:'Top P',maxOutputTokens:'Ответ'} as Record<string,string>)[key]}: ${value}`).join(' · ');
    return {name:`${candidate.name} · ${candidate.provider} · ${scope==='global'?'общая':'проект'}`.slice(0,128),description:`OpenCode: ${source}. Провайдер: ${candidate.provider}.`+(parameters?' '+parameters+'.':'')};
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const descriptorDigest = (row: IModelRow): string => { const { verificationSha256: _pin, ...metadata } = row.descriptor; return digest([row.name, metadata]); };
const incomplete = new Set(['read-failed', 'invalid-json', 'unsafe-path', 'source-changed', 'entry-limit', 'ambiguous-config']);

/** Source updates are atomic; only the originating computer may update an untouched auto-owned connection. */
export class OpenCodeModelSyncRepository {
    constructor(readonly pool: Pool) {}
    async settings(id: string, db: Pick<PoolClient, 'query'> = this.pool): Promise<OpenCodeSyncSettings> {
        const row = (await db.query<{ revision: number; enabled: boolean; transfer_credentials: boolean }>('SELECT * FROM opencode_model_sync_settings WHERE device_id=$1', [id])).rows[0];
        return row ? { revision: row.revision, enabled: row.enabled, transferCredentials: row.transfer_credentials } : { ...defaultOpenCodeSyncSettings };
    }
    async sources(id: string) {
        return (await this.pool.query(`SELECT CASE WHEN s.project_id IS NULL THEN 'global' ELSE 'project' END AS scope,s.project_id AS "projectId",pr.name AS "projectName",s.provider,s.config_key AS "configKey",s.model_id AS "modelId",c.name,c.archived_at AS "archivedAt",
            EXISTS(SELECT 1 FROM project_models p WHERE p.project_id=s.project_id AND p.model_id=s.model_id) AS assigned,
            (c.id IS NOT NULL AND c.archived_at IS NULL AND r.revoked_at IS NULL AND (r.semantic_sha IS NULL OR r.semantic_sha IS DISTINCT FROM c.descriptor->>'verificationSha256' OR r.failure_message IS NOT NULL)) AS "needsCheck",
            (r.model_id IS NOT NULL AND r.revoked_at IS NULL AND r.credential_kind='stored') AS "hasServerKey",
            r.credential_kind AS "_credentialKind",r.credential_env AS "_credentialEnv",
            (r.revoked_at IS NOT NULL) AS revoked,
            s.output_token_limit AS "outputTokenLimit",s.context_window AS "contextWindow",s.state,s.credential_status AS "credentialStatus",s.checked_at AS "checkedAt" FROM opencode_model_sources s
            LEFT JOIN projects pr ON pr.id=s.project_id LEFT JOIN model_catalog c ON c.id=s.model_id LEFT JOIN LATERAL (SELECT * FROM model_remote_connections WHERE model_id=s.model_id ORDER BY revision DESC LIMIT 1) r ON true
            WHERE s.device_id=$1 ORDER BY s.project_id,s.provider,s.config_key LIMIT 1000`, [id])).rows.map(({ _credentialKind, _credentialEnv, ...row }) => ({ ...row,
                hasServerKey: row.hasServerKey || !row.revoked && _credentialKind === 'environment' && !!process.env[_credentialEnv] }));
    }
    async sync(device: { id: string; email: string }, scan: IOpenCodeModelScan, settings: OpenCodeSyncSettings, credentials: Record<string, string>, authorize: (db: PoolClient) => Promise<void>) {
        const db = await this.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:opencode-model-sync',0))");
            await authorize(db);
            const current = await this.settings(device.id, db);
            if (JSON.stringify(current) !== JSON.stringify(settings) || !current.enabled) throw new ConflictException('Настройки синхронизации изменились. Повторите чтение OpenCode.');
            if (scan.warnings.some(value => incomplete.has(value))) { await db.query('COMMIT'); return { changed: false, imported: 0, incomplete: true }; }
            const projectId=scan.scope==='project'?scan.projectId:null, scopeKey=scan.scope==='project'?'project:'+scan.projectId:'global';
            const previous = (await db.query<{ checked_at: Date; scan_id: string; scan_digest: string }>('SELECT checked_at,scan_id,scan_digest FROM opencode_model_snapshots WHERE device_id=$1 AND scope_key=$2', [device.id, scopeKey])).rows[0];
            if (previous && (new Date(previous.checked_at).getTime() > Date.parse(scan.checkedAt) || previous.scan_id === scan.scanId && previous.scan_digest !== scan.digest)) throw new ConflictException('Получен устаревший или изменённый снимок OpenCode.');
            let changed = false, imported = 0;
            for (const candidate of scan.candidates) {
                const sourceKey = digest([candidate.provider, candidate.configKey ?? candidate.model]);
                const old = (await db.query('SELECT model_id,state,credential_status,context_window,output_token_limit FROM opencode_model_sources WHERE device_id=$1 AND scope_key=$2 AND source_key=$3', [device.id, scopeKey, sourceKey])).rows[0];
                let modelId: string | null = old?.model_id ?? null;
                let credentialStatus = 'not-needed';
                if (!candidate.blocker && candidate.runtime && candidate.baseUrl) {
                    const result = await this.upsert(db, device, scopeKey, scan.scope, candidate, credentials[candidate.candidateId]);
                    modelId = result.id; credentialStatus = result.credentialStatus; changed ||= result.changed; imported += Number(result.created);
                    if (projectId!==null&&(!old || old.model_id !== modelId)) {
                        const assigned = await db.query(`INSERT INTO project_models(project_id,model_id,added_by) SELECT $1,id,$3 FROM model_catalog WHERE id=$2 AND archived_at IS NULL
                            ON CONFLICT(project_id,model_id) DO NOTHING RETURNING *`, [projectId, modelId, device.email]);
                        if (assigned.rowCount) { changed = true; await securityEvent(db, { actor: device.email, action: 'project.model.add', resourceId: projectId + ' · ' + modelId, before: null, after: { projectId, modelId, automatic: true } }); }
                    }
                } else if (candidate.hasKey) credentialStatus = 'unavailable';
                const state = candidate.blocker === 'disabled-provider' ? 'disabled' : candidate.blocker ? 'blocked' : 'present';
                changed ||= !old || old.model_id !== modelId || old.state !== state || old.credential_status !== credentialStatus || old.context_window !== (candidate.options?.contextWindow ?? null) || old.output_token_limit !== (candidate.outputTokenLimit ?? null);
                await db.query(`INSERT INTO opencode_model_sources(device_id,project_id,scope_key,source_key,provider,config_key,model_id,binding_id,instance_id,scan_id,state,credential_status,checked_at,output_token_limit,context_window)
                    VALUES($1,$2,$15,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(device_id,scope_key,source_key) DO UPDATE
                    SET model_id=EXCLUDED.model_id,binding_id=EXCLUDED.binding_id,instance_id=EXCLUDED.instance_id,scan_id=EXCLUDED.scan_id,state=EXCLUDED.state,credential_status=EXCLUDED.credential_status,checked_at=EXCLUDED.checked_at,output_token_limit=EXCLUDED.output_token_limit,context_window=EXCLUDED.context_window`,
                [device.id, projectId, sourceKey, candidate.provider, candidate.configKey ?? candidate.model, modelId, scan.scope==='project'?scan.bindingId:null, scan.scope==='project'?scan.instanceId:null, scan.scanId, state, credentialStatus, scan.checkedAt, candidate.outputTokenLimit ?? null, candidate.options?.contextWindow ?? null, scopeKey]);
            }
            const missing = await db.query(`UPDATE opencode_model_sources SET state='missing',checked_at=$4 WHERE device_id=$1 AND scope_key=$2 AND scan_id<>$3 AND state<>'missing' RETURNING source_key`, [device.id, scopeKey, scan.scanId, scan.checkedAt]);
            changed ||= !!missing.rowCount;
            await db.query(`INSERT INTO opencode_model_snapshots(device_id,scope_key,scan_id,scan_digest,checked_at,project_id) VALUES($1,$2,$3,$4,$5,$6)
                ON CONFLICT(device_id,scope_key) DO UPDATE SET scan_id=EXCLUDED.scan_id,scan_digest=EXCLUDED.scan_digest,checked_at=EXCLUDED.checked_at`, [device.id, scopeKey, scan.scanId, scan.digest, scan.checkedAt, projectId]);
            await authorize(db); await db.query('COMMIT');
            return { changed, imported, incomplete: false };
        } catch (cause) { await db.query('ROLLBACK').catch(() => undefined); throw cause; }
        finally { db.release(); }
    }
    private async upsert(db: PoolClient, device: { id: string; email: string }, sourceScopeKey: string,scope:'global'|'project', candidate: IOpenCodeModelCandidate, key?: string) {
        const id = await resolveOpenCodeIdentity(db,candidate), baseUrl = remoteModelBaseUrl(candidate.baseUrl), options = remoteModelOptions(candidate.options), timeoutMs = remoteModelTimeout(candidate.timeoutMs);
        const sourceKey = digest([sourceScopeKey, candidate.provider, candidate.configKey ?? candidate.model]);
        let row = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id])).rows[0];
        const created = !row;
        if (!row) {
            const metadata=openCodeCardMetadata(candidate,scope);let name=metadata.name;
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-name:'||lower($1),0))", [name]);
            if ((await db.query('SELECT 1 FROM model_catalog WHERE lower(name)=lower($1)', [name])).rowCount) name = name.slice(0, 115) + ' · ' + id.slice(-8);
            const { name: _name, ...native } = validateModelCreate({ name, description:metadata.description, runtime: candidate.runtime, model: candidate.model, modelVersion: candidate.modelVersion, capability: candidate.capability });
            row = (await db.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *', [id, name, JSON.stringify({ ...native, source: 'custom', manifestSha256: null, verificationSha256: null })])).rows[0]!;
            await saveModelVersion(db, row);
            await db.query('INSERT INTO opencode_managed_models(model_id,device_id,source_key,descriptor_sha,connection_revision) VALUES($1,$2,$3,$4,0)', [id, device.id, sourceKey, descriptorDigest(row)]);
            await securityEvent(db, { actor: device.email, action: 'model.import.opencode', resourceId: id, before: null, after: { provider: candidate.provider, model: candidate.model, automatic: true } });
        }
        await saveOpenCodeIdentity(db,candidate,id);
        const repository = new RemoteConnectionRepository(this.pool), head = await repository.head(id, db);
        const managed = (await db.query<{ device_id: string; source_key: string; descriptor_sha: string; connection_revision: string }>('SELECT * FROM opencode_managed_models WHERE model_id=$1', [id])).rows[0];
        const owned = !!managed && managed.device_id === device.id && managed.source_key === sourceKey && managed.descriptor_sha === descriptorDigest(row) && Number(managed.connection_revision) === Number(head?.revision ?? 0) && !head?.revoked_at && !row.archived_at;
        if (!owned) return { id, created, changed: created, credentialStatus: 'manual' };
        const keyAvailable = !!key && canStoreModelCredential();
        // Absent local credentials never erase a previously stored server key.
        const previousKey = head?.credential_kind === 'stored' && !head.revoked_at ? repository.connection(head).apiKey : undefined;
        const effectiveKey = keyAvailable ? key : previousKey;
        const credentialStatus = effectiveKey ? 'transferred' : candidate.hasKey ? key ? 'unavailable' : 'pending' : 'not-needed';
        const failure = candidate.hasKey && !effectiveKey ? 'Добавьте API-ключ на сервере или разрешите перенос ключей с этого компьютера.' : null;
        if (head && !head.revoked_at && row.descriptor.capability === candidate.capability && head.base_url === baseUrl && digest(head.options) === digest(options) && head.timeout_ms === timeoutMs && previousKey === effectiveKey) {
            return { id, created, changed: created, credentialStatus };
        }
        const revision = Number(head?.revision ?? 0) + 1;
        const sealed = effectiveKey ? sealModelCredential(effectiveKey, id, revision) : null;
        await db.query(`INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,credential,credential_env,options,timeout_ms,failure_message)
            VALUES($1,$2,$3,false,$4,$5::jsonb,NULL,$6::jsonb,$7,$8)`, [id, revision, baseUrl, sealed ? 'stored' : 'none', sealed ? JSON.stringify(sealed) : null, JSON.stringify(options), timeoutMs, failure]);
        if (!created) {
            const next = await nextModelRevision(db, id, row.revision);
            row = (await db.query<IModelRow>(`UPDATE model_catalog SET descriptor=descriptor||$3::jsonb,revision=$2,updated_at=now() WHERE id=$1 RETURNING *`, [id, next, JSON.stringify({ verificationSha256: null, capability: candidate.capability })])).rows[0]!;
            await saveModelVersion(db, row);
        }
        await db.query('UPDATE opencode_managed_models SET connection_revision=$2,descriptor_sha=$3 WHERE model_id=$1', [id, revision, descriptorDigest(row)]);
        await securityEvent(db, { actor: device.email, action: 'model.connection.sync', resourceId: id, before: head ? { revision: Number(head.revision) } : null, after: { revision, hasKey: !!sealed } });
        return { id, created, changed: true, credentialStatus };
    }
}
