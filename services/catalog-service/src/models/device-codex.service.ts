import {deviceCodexIdentityDigest,deviceCodexConflict} from './device-codex-identity';
import {notifyDeviceOperations} from '../devices/device-operations';
import {projectDeviceCodexOperation} from './device-codex-operation';
import { DeviceCodexConnections } from './device-codex-connections';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { DEVICE_CODEX_JOB, DEVICE_CODEX_PROTOCOL, normalizeDeviceCodexPayload, normalizeDeviceCodexRequest, normalizeDeviceCodexContext, type DeviceCodexSource, type DeviceCodexPayload, type DeviceCodexResult, type DeviceCodexRequest } from '../../../shared/device-codex-inference.cjs';
import type { IOpenCodeModelCandidate } from '../../../shared/opencode-model-scan.cjs';
import { requiredInferenceFeatures } from '../../../shared/feature-policy.cjs';
import type { FeatureFlagKey } from '../../../shared/feature-flags.cjs';
import { type IAccessActor } from '../access/access.model';
import { DeviceStore, digest, type Device } from '../devices/device-store';
import { DeviceArtifacts } from '../devices/device-artifacts';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { currentModelUsage } from '../model-usage/model-usage.context';
import {currentModelDispatchMetrics,createModelDispatchMetrics,withModelDispatchMetrics} from '../model-usage/model-dispatch-metrics';
import { ModelApiAdmission } from '../model-api-admission/model-api-admission';
import { ModelsService } from './models.service';
import { projectEmbeddingPin } from './project-embedding.validation';
import type { IModel } from './model.types';
type Db = Pick<PoolClient, 'query'>;
interface Call {
    id: string;
    job_id: string;
    model_id: string;
    device_id: string;
    owner_email: string;
    actor_role: string;
    project_id: string | null;
    model_pin: string;
    connection_revision: number;
    request: DeviceCodexRequest;
    required_features: FeatureFlagKey[];
    deadline_at: Date;
    dispatched_at: Date | null;
    cancelled_at: Date | null;
    result: DeviceCodexResult | null;
    state: string;
    payload: unknown;
    lease: string;
}
/** Device-only OAuth transport. The public queue holds identifiers; private calls hold prompt and output. */
@Injectable()
export class DeviceCodexService {
    private readonly connections: DeviceCodexConnections;
    constructor(private readonly models: ModelsService, devices: DeviceStore, artifacts: DeviceArtifacts, private readonly admission: ModelApiAdmission) {
        this.connections = new DeviceCodexConnections(models, devices, artifacts);
    }
    async importModel(req: Request, device: Device, candidate: IOpenCodeModelCandidate, source: DeviceCodexSource, projectId: string | null, name: string, expiresAt: string) {
        return this.connections.importModel(req, device, candidate, source, projectId, name, expiresAt);
    }
    async status(model: IModel, actor?: IAccessActor) { return this.connections.status(model, actor); }
    async infer(model: IModel, endpoint: 'chat' | 'embed', body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
        if (endpoint !== 'chat' || model.capability === 'embedding')
            throw new BadRequestException('Codex на компьютере не поддерживает embedding.');
        const context = currentModelUsage();
        if (!context.actorEmail || !context.actorRole)
            throw new ForbiddenException('Для Codex нужна текущая роль пользователя. Запустите действие из своего профиля.');
        let request: DeviceCodexRequest;
        try {
            request = normalizeDeviceCodexRequest({ messages: body.messages, options: body.options ?? {} }, model.capability);
        }
        catch {
            throw new BadRequestException('Codex поддерживает текст и изображения, reasoningEffort и store:false. Температура, topP и лимит ответа недоступны.');
        }
        const connection = await this.connections.read(model.id);
        request.options = { ...connection.options, ...request.options };
        const flags: FeatureFlagKey[] = [...new Set<FeatureFlagKey>(['device_codex_inference', ...requiredInferenceFeatures(context.purpose, context.agentId), ...(context.requiredFeatures ?? [])])];
        await requireFeaturesEnabled(flags);
        await this.connections.assertCurrent(connection, { email: context.actorEmail, activeRole: context.actorRole }, context.projectId ?? null, model);
        const metrics=currentModelDispatchMetrics(),admissionMetrics=createModelDispatchMetrics();
        // The durable marker records one-send admission; it cannot prove the provider received a request.
        return withModelDispatchMetrics(admissionMetrics,()=>this.admission.run(model, signal, async () => {
            signal?.throwIfAborted();
            const callId = randomUUID(), jobId = randomUUID(), deadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            const payload: DeviceCodexPayload = { protocol: DEVICE_CODEX_PROTOCOL, callId, modelId: model.id, modelPin: projectEmbeddingPin(model), connectionRevision: connection.revision, source: connection.source, deadlineAt };
            const db = await this.models.pool.connect();
            let dispatchedAt:number|null=null;
            const observeDispatch=async(call:Call)=>{
                if(!call.dispatched_at||dispatchedAt!==null)return;
                dispatchedAt=new Date(call.dispatched_at).getTime();
                if(metrics){metrics.dispatchCount++;metrics.dispatchedAt??=new Date(dispatchedAt).toISOString();await metrics.progress?.(true);}
            };
            try {
                await db.query('BEGIN');
                await this.connections.assertCurrent(connection, { email: context.actorEmail!, activeRole: context.actorRole! }, context.projectId ?? null, model, db);
                await requireFeaturesEnabled(flags);
                signal?.throwIfAborted();
                await db.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,message) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$1,$8,$9)`, [jobId, connection.device_id, context.actorEmail, context.actorRole, context.projectId ?? null, DEVICE_CODEX_JOB, JSON.stringify(payload), deviceCodexIdentityDigest(payload), 'Ожидает Codex на компьютере']);
                await db.query(`INSERT INTO device_model_calls(id,job_id,model_id,device_id,owner_email,actor_role,project_id,model_pin,runtime_model,connection_revision,request,required_features,deadline_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13)`, [callId, jobId, model.id, connection.device_id, context.actorEmail, context.actorRole, context.projectId ?? null, payload.modelPin, model.model, connection.revision, JSON.stringify(request), JSON.stringify(flags), deadlineAt]);
                await db.query('COMMIT');
            }
            catch (e) {
                await db.query('ROLLBACK').catch(() => undefined);
                throw e;
            }
            finally {
                db.release();
            }
            try {
                let checkedAt = 0;
                while (true) {
                    const call = await this.call(jobId), result = call.result;
                    await observeDispatch(call);
                    if (call.cancelled_at)
                        throw new ServiceUnavailableException('Запрос Codex отменён. Полученная квитанция сохранена без применения результата.');
                    if (result && 'response' in result)
                        return { ...result.response };
                    if (result && 'error' in result) {
                        if (!call.dispatched_at && result.error.code === 'runtime-cache-full')
                            throw new ServiceUnavailableException('На компьютере заполнен кэш готовых комплектов. Запрос остановлен до отправки в Codex. Попросите владельца компьютера открыть «Мои компьютеры → Подробнее → Кэш комплектов» и увеличить лимит. Затем повторите запрос. Автоматический повтор не выполняется.');
                        if (!call.dispatched_at && result.error.code === 'disk-full')
                            throw new ServiceUnavailableException('На компьютере недостаточно свободного места для комплекта Codex. Запрос остановлен до отправки в Codex. Попросите владельца компьютера освободить место на диске, затем отправьте запрос снова. Автоматический повтор не выполняется.');
                        throw new ServiceUnavailableException('Codex не завершил запрос (' + result.error.code + '). Полученный результат не запускается повторно автоматически.');
                    }
                    signal?.throwIfAborted();
                    if (Date.now() >= Date.parse(deadlineAt))
                        throw new ServiceUnavailableException('Codex не ответил вовремя. Запрос остановлен; автоматический повтор не выполняется.');
                    if (['cancelled', 'failed', 'reconciling'].includes(call.state))
                        throw new ServiceUnavailableException('Вызов Codex остановлен или потерял подтверждение. Автоматический повтор не выполняется.');
                    if (Date.now() - checkedAt >= 1000) {
                        await context.beforeInference?.();
                        await this.assertCall(call);
                        checkedAt = Date.now();
                    }
                    await delay(250, undefined, { signal });
                }
            }
            catch (e) {
                await this.cancel(jobId);
                await this.call(jobId).then(observeDispatch).catch(()=>undefined);
                throw e;
            }
            finally{
                if(metrics){
                    metrics.rateWaitMs+=admissionMetrics.rateWaitMs;
                    if(dispatchedAt!==null)metrics.providerLatencyMs+=Math.max(0,Date.now()-dispatchedAt);
                    await metrics.progress?.(false);
                }
            }
        }));
    }
    private async call(jobId: string, db: Db = this.models.pool): Promise<Call> {
        const call = (await db.query<Call>('SELECT c.*,j.state,j.payload,j.lease FROM device_model_calls c JOIN bridge_jobs j ON j.id=c.job_id WHERE c.job_id=$1', [jobId])).rows[0];
        if (!call)
            deviceCodexConflict();
        return call;
    }
    private async assertCall(call: Call, db: Db = this.models.pool) {
        if (call.cancelled_at || call.result || !['queued', 'running'].includes(call.state) || new Date(call.deadline_at).getTime() <= Date.now())
            throw new ConflictException('Вызов Codex завершён, отменён или его срок истёк.');
        const payload = normalizeDeviceCodexPayload(call.payload), connection = await this.connections.read(call.model_id, db), model = await this.models.get(call.model_id);
        if (call.id !== payload.callId || call.model_pin !== payload.modelPin || call.connection_revision !== connection.revision || payload.connectionRevision !== connection.revision || deviceCodexIdentityDigest(payload.source) !== deviceCodexIdentityDigest(connection.source) || projectEmbeddingPin(model) !== call.model_pin)
            deviceCodexConflict();
        await this.connections.assertCurrent(connection, { email: call.owner_email, activeRole: call.actor_role }, call.project_id, model, db);
        await requireFeaturesEnabled(call.required_features);
        const fresh = await db.query(`SELECT c.id FROM device_model_calls c JOIN bridge_jobs j ON j.id=c.job_id
   JOIN model_device_connections m ON m.model_id=c.model_id JOIN bridge_devices d ON d.id=c.device_id
   JOIN model_catalog model ON model.id=c.model_id JOIN platform_users u ON u.email=c.owner_email
   LEFT JOIN project_members member ON member.project_id=c.project_id AND lower(member.principal_name)=c.owner_email
   WHERE c.job_id=$1 AND c.cancelled_at IS NULL AND c.result IS NULL AND c.deadline_at>clock_timestamp()
   AND j.state IN ('queued','running') AND j.payload=$2::jsonb AND m.revision=c.connection_revision AND m.revoked_at IS NULL
   AND d.email=c.owner_email AND NOT d.revoked AND d.expires_at>clock_timestamp() AND model.archived_at IS NULL
   AND model.descriptor->>'verificationSha256'=m.semantic_sha AND u.enabled
   AND (CASE WHEN c.actor_role='Главный админ' THEN u.is_main_admin ELSE c.project_id IS NOT NULL
    AND c.actor_role IN ('Админ проекта','Разработчик') AND member.role IN ('Админ проекта','Разработчик') AND (c.actor_role<>'Админ проекта' OR member.role='Админ проекта') END)
   AND (CASE WHEN d.role='Главный админ' THEN u.is_main_admin ELSE member.role IN ('Админ проекта','Разработчик') AND d.role IN ('Админ проекта','Разработчик') END)
   AND (m.source->>'scope'='global' OR EXISTS(SELECT 1 FROM jsonb_array_elements(d.report->'bindings') b WHERE b->>'projectId'=c.project_id
    AND b->>'bindingId'=m.source->>'bindingId' AND b->>'instanceId'=m.source->>'instanceId' AND b->>'valid' IS DISTINCT FROM 'false'))`, [call.job_id, JSON.stringify(payload)]);
        if (!fresh.rows.length)
            throw new ConflictException('Права, подключение Codex или папка изменились во время проверки.');
    }
    async authorizeJob(device: Device, job: {
        id: string;
        kind: string;
        lease: string;
    }) {
        if (job.kind !== DEVICE_CODEX_JOB)
            return;
        const call = await this.call(job.id);
        if (call.device_id !== device.id || call.owner_email !== device.email || call.lease !== job.lease)
            deviceCodexConflict();
        await this.assertCall(call);
    }
    async context(device: Device, input: unknown) {
        const { jobId, lease } = this.input(input), call = await this.leased(device, jobId, lease);
        await this.assertCall(call);
        const connection = await this.connections.read(call.model_id), model = await this.models.get(call.model_id);
        return normalizeDeviceCodexContext({ protocol: DEVICE_CODEX_PROTOCOL, callId: call.id, model: model.model, capability: model.capability, ...call.request, source: connection.source, expectedCandidate: connection.expected_candidate, connectorPackage: connection.connector_package, deadlineAt: new Date(call.deadline_at).toISOString() });
    }
    async dispatch(device: Device, input: unknown) {
        const { jobId, lease, callId } = this.input(input, true);
        await this.leased(device, jobId, lease);
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query('SELECT id FROM bridge_jobs WHERE id=$1 FOR UPDATE', [jobId]);
            await db.query('SELECT id FROM device_model_calls WHERE job_id=$1 FOR UPDATE', [jobId]);
            const call = await this.call(jobId, db);
            if (call.id !== callId)
                deviceCodexConflict();
            await this.assertCall(call, db);
            const updated = await db.query(`UPDATE device_model_calls c SET dispatched_at=clock_timestamp() FROM bridge_jobs j,model_device_connections m,bridge_devices d,model_catalog card
   WHERE c.job_id=$1 AND c.id=$2 AND c.device_id=$3 AND j.id=c.job_id AND j.lease=$4 AND j.state='running' AND j.lease_until>clock_timestamp()
   AND c.cancelled_at IS NULL AND c.result IS NULL AND c.dispatched_at IS NULL AND c.deadline_at>clock_timestamp()
   AND m.model_id=c.model_id AND m.revision=c.connection_revision AND m.revoked_at IS NULL AND d.id=c.device_id AND NOT d.revoked AND d.expires_at>clock_timestamp()
   AND card.id=c.model_id AND card.archived_at IS NULL AND card.descriptor->>'verificationSha256'=m.semantic_sha RETURNING c.id`, [jobId, callId, device.id, lease]);
            if (!updated.rowCount)
                throw new ConflictException('Вызов уже отправлен или изменился. Повторная отправка запрещена.');
            await db.query('COMMIT');
            return { ok: true };
        }
        catch (e) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw e;
        }
        finally {
            db.release();
        }
    }
    private input(value: unknown, dispatch = false): {
        jobId: string;
        lease: string;
        callId?: string;
    } {
        const v = value as Record<string, unknown> | null;
        if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== (dispatch ? 'callId,jobId,lease' : 'jobId,lease') || ['jobId', 'lease', ...(dispatch ? ['callId'] : [])].some(k => typeof v[k] !== 'string' || !/^[-a-f0-9]{36}$/.test(String(v[k]))))
            throw new BadRequestException('Нужны точное задание и аренда Codex.');
        return v as {
            jobId: string;
            lease: string;
            callId?: string;
        };
    }
    private async leased(device: Device, jobId: string, lease: string) {
        const found = await this.models.pool.query("SELECT id FROM bridge_jobs WHERE id=$1 AND device_id=$2 AND email=$3 AND lease=$4 AND kind=$5 AND state='running' AND lease_until>clock_timestamp()", [jobId, device.id, device.email, lease, DEVICE_CODEX_JOB]);
        if (!found.rows.length)
            deviceCodexConflict();
        return this.call(jobId);
    }
    async cancel(jobId: string) {
        const db = await this.models.pool.connect();
        let projected=false;
        let outcome:{cancelled:boolean;state:string};
        try {
            await db.query('BEGIN');
            const current=(await db.query<{id:string;kind:string;state:string;project_id:string|null;email:string;message:string}>('SELECT id,kind,state,project_id,email,message FROM bridge_jobs WHERE id=$1 FOR UPDATE', [jobId])).rows[0];
            if(current?.kind===DEVICE_CODEX_JOB&&['queued','running','reconciling','cancelled'].includes(current.state)){
                await db.query("UPDATE device_model_calls SET cancelled_at=COALESCE(cancelled_at,clock_timestamp()) WHERE job_id=$1 AND result IS NULL", [jobId]);
                await db.query("UPDATE bridge_jobs SET state='cancelled',message='Запрос Codex остановлен; автоматический повтор не выполняется.',updated_at=clock_timestamp() WHERE id=$1 AND kind=$2 AND state IN ('queued','running','reconciling')", [jobId, DEVICE_CODEX_JOB]);
                await projectDeviceCodexOperation(db,jobId);projected=true;outcome={cancelled:true,state:'cancelled'};
            }else outcome={cancelled:false,state:current?.state??'missing'};
            await db.query('COMMIT');
        }
        catch (e) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw e;
        }
        finally {
            db.release();
        }
        if(projected)void notifyDeviceOperations();
        return outcome;
    }
    /** A revoked connection can only acknowledge the already-leased private result; it cannot fetch context or dispatch. */
    async receiptIdentity(token: string, jobId: string, lease: string): Promise<Device | undefined> {
        if (!/^[a-f0-9]{64}$/.test(token))
            return;
        return (await this.models.pool.query<Device>(`SELECT d.* FROM bridge_devices d JOIN bridge_jobs j ON j.device_id=d.id JOIN device_model_calls c ON c.job_id=j.id
   WHERE d.token_hash=$1 AND j.id=$2 AND j.lease=$3 AND j.kind=$4 AND c.dispatched_at IS NOT NULL`, [digest(token), jobId, lease, DEVICE_CODEX_JOB])).rows[0];
    }
}
