import {PROJECT_AGENTS_JOB} from '../../../shared/project-agents.cjs';
import {securityEvent} from '../access/security-events';
import { LOCAL_APPLIES } from './project-local-actions';
import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import type { Pool,PoolClient } from 'pg';
import { notifyDeviceOperations, recordDeviceOperation } from './device-operations';
import { guardWorkspaceQueue } from './workspace-queue';
import type { IAccessClaims } from '../access/access.model';
import { reclaimUnauthorizedQueuedJobs } from './device-job-access';
import {findDeviceJobRequest,saveDeviceJobRequest} from './device-job-requests';

interface Enqueue {
    id: string; deviceId: string; email: string; role: string; projectId?: string;
    kind: string; payload: Record<string, unknown>; requestKey: string; requestHash: string;
}
type Row = Record<string, unknown> & { id: string; request_hash?: string; role?: string; payload?: Record<string, unknown> };
const clean = (row: Row): Row => {
    const { request_hash: _hash, role: _role, payload: _payload, ...publicRow } = row;
    return publicRow;
};

/** Lock устройства объединяет две вкладки в одно ожидающее действие и ограничивает размер очереди. */
export async function enqueueDeviceJob(pool: Pool, view: string, input: Enqueue, readClaims:(db:PoolClient)=>Promise<IAccessClaims>,postInsert?:(db:PoolClient,jobId:string)=>Promise<void>): Promise<Row> {
    const client = await pool.connect();
    let result: Row;
    try {
        await client.query('BEGIN');
        const owned = await client.query<{id:string;role:string}>('SELECT id,role FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR UPDATE', [input.deviceId, input.email]);
        if (!owned.rows.length) { throw new ForbiddenException('Подключение MCP истекло или отключено.'); }
        const previous = await findDeviceJobRequest(client,view,input);
        if (previous) {
            await client.query('COMMIT');
            return clean(previous);
        }
        const reclaimed=await reclaimUnauthorizedQueuedJobs(client,{id:input.deviceId,email:input.email,role:owned.rows[0].role},
            {role:input.role,project_id:input.projectId??null,kind:input.kind},()=>readClaims(client));
        await guardWorkspaceQueue(client, input);
        if (['install','uninstall',...LOCAL_APPLIES].includes(input.kind)) {
            const pending = await client.query<Row>(`SELECT ${view},role,payload FROM bridge_jobs WHERE device_id=$1 AND project_id=$2
                AND kind IN ('install','uninstall','apply-local-change','apply-adopt-installation','apply-local-restore') AND payload->>'assetKind'=$3 AND payload->>'assetId'=$4
                AND state IN ('queued','running','reconciling') ORDER BY created_at LIMIT 1 FOR UPDATE`,
            [input.deviceId, input.projectId, input.payload.assetKind, input.payload.assetId]);
            const current = pending.rows[0];
            if (current) {
                const manifest = (payload: Record<string, unknown> | undefined) => (payload?.installSet as {manifest?:string}|undefined)?.manifest ?? (payload?.package as { manifest?: { sha256?: string } } | undefined)?.manifest?.sha256;
                const replacedApproval = input.kind === 'install' && current.kind === 'install' && current.state === 'queued'
                    && current.payload?.planId === input.payload.planId && current.payload?.planRevision !== input.payload.planRevision;
                if (replacedApproval) {
                    const message = 'Одобрение версии изменилось; ожидающее задание заменено новым планом.';
                    await client.query("UPDATE bridge_jobs SET state='cancelled',message=$2,updated_at=now() WHERE id=$1", [current.id, message]);
                    await recordDeviceOperation(client, { id: current.id, kind: 'install', email: input.email, project_id: input.projectId || null }, 'CANCELLED', 0, message);
                } else if (current.kind !== input.kind || current.role !== input.role || manifest(current.payload) !== manifest(input.payload)
                    || current.payload?.bindingId !== input.payload.bindingId || current.payload?.planId !== input.payload.planId || current.payload?.planRevision !== input.payload.planRevision
                    || current.payload?.changePlanId !== input.payload.changePlanId || current.payload?.expectedChangeDigest !== input.payload.expectedChangeDigest) {
                    throw new ConflictException('Для этого инструмента уже выполняется другое действие или ожидается сверка. Дождитесь результата.');
                } else {
                    const saved=await saveDeviceJobRequest(client,view,input,current.id);
                    await client.query('COMMIT');
                    if(reclaimed)await notifyDeviceOperations();
                    return clean(saved);
                }
            }
        }
        const count = await client.query<{ count: string }>("SELECT count(*) FROM bridge_jobs WHERE device_id=$1 AND state IN ('queued','running','reconciling')", [input.deviceId]);
        if (Number(count.rows[0]?.count) >= 100) { throw new HttpException('На компьютере уже 100 ожидающих действий. Завершите или отмените задания перед добавлением новых.', 429); }
        await client.query(`INSERT INTO bridge_jobs(id,device_id,email,role,project_id,kind,payload,request_key,request_hash,message)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(email,request_key) DO NOTHING`,
        [input.id, input.deviceId, input.email, input.role, input.projectId || null, input.kind, input.payload, input.requestKey, input.requestHash, 'Ожидает моста']);
        const saved = await client.query<Row>(`SELECT ${view},request_hash FROM bridge_jobs WHERE email=$1 AND request_key=$2`, [input.email, input.requestKey]);
        if (!saved.rows[0] || saved.rows[0].request_hash !== input.requestHash) { throw new ConflictException('Параллельный запрос использовал этот ключ с другими параметрами.'); }
        result = clean(await saveDeviceJobRequest(client,view,input,saved.rows[0].id));
        if (result.id === input.id) {
            // Related server receipts share this transaction; accepted retries never invoke the hook again.
            await postInsert?.(client,input.id);
            if(input.kind===PROJECT_AGENTS_JOB)await securityEvent(client,{actor:input.email,action:'project.agents.connect',resourceId:input.projectId!,before:null,after:{projectId:input.projectId,revision:input.payload.revision,deviceId:input.deviceId,bindingId:input.payload.bindingId,instanceId:input.payload.instanceId,manifestSha256:input.payload.manifestSha256,jobId:input.id}});
            await recordDeviceOperation(client, { id: input.id, kind: input.kind, email: input.email, project_id: input.projectId || null }, 'QUEUED', 0, 'Ожидает моста');
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
    } finally { client.release(); }
    await notifyDeviceOperations();
    return result;
}
