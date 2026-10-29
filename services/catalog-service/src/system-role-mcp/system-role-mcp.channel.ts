import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { normalizeRoleMcpResult, SYSTEM_ROLE_MCP_JOB, type RoleMcpExecutionResult, type RoleMcpSessionContext } from '../../../shared/system-role-mcp.cjs';
import { digest, type Device, type DeviceStore } from '../devices/device-store';
import { SystemRoleMcpRepository } from './system-role-mcp.repository';
import { mcpCallContext, type McpCallRow, type McpSessionRow } from './system-role-mcp.store-types';

type Db = Pick<PoolClient, 'query'>;
interface LeaseInput { jobId: string; lease: string; callId?: string; result?: unknown; state?: 'succeeded' | 'failed'; message?: string; }
export interface McpChannelFence { sessionId: string; lease: string; deviceId: string; }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const future = (value: Date | string | null): boolean => value !== null && new Date(value).getTime() > Date.now();
const conflict = (): never => { throw new ConflictException('Сессия инструмента завершена, потеряла аренду или относится к другому подключению.'); };

/** A private two-session device lane; receipt-only ACKs never regain execution authority. */
export class SystemRoleMcpChannel {
    constructor(private readonly repository: SystemRoleMcpRepository, private readonly devices: DeviceStore,
        private readonly authority: (session: McpSessionRow, db?: Db) => Promise<void>,
        private readonly dispatchCall: (callId: string, expectedChannel?: McpChannelFence) => Promise<unknown>,
        private readonly closeSession: (id: string, onlyUnclaimed?: boolean) => Promise<unknown>,
        private readonly preflight?: (session: McpSessionRow) => Promise<void>,
        private readonly releaseDeviceSession: (id: string) => void = () => undefined) {}

    async claim(token: unknown, input: unknown) {
        if (!object(input) || Object.keys(input).sort().join(',') !== 'recoveryOnly,requestId' || !uuid(input.requestId)
            || typeof input.recoveryOnly !== 'boolean') throw new BadRequestException('Нужны сохранённый идентификатор запроса и режим восстановления MCP.');
        const requestId = input.requestId;
        const recovered = await this.repository.transaction(db => this.recoverClaim(db, token, requestId, input.recoveryOnly as boolean));
        if (recovered === false) return null;
        if (recovered) { this.releaseDeviceSession(recovered.id); return recovered; }
        if (input.recoveryOnly) return null;
        const device = await this.devices.identity(token);
        // A candidate is immutable. External availability checks finish before any row lock is taken.
        for (let attempt = 0; attempt < 32; attempt++) {
            const candidate = (await this.repository.pool.query<McpSessionRow>(`SELECT * FROM system_role_mcp_sessions
                WHERE state='open' AND claimed_at IS NULL AND deadline_at>clock_timestamp()
                AND target->>'runtime'='device' AND target->>'deviceId'=$1 AND owner_email=$2
                ORDER BY created_at,id LIMIT 1`, [device.id, device.email])).rows[0];
            if (!candidate) return null;
            try { await this.preflight?.(candidate); }
            catch (error) {
                if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error;
                await this.closeSession(candidate.id, true); continue;
            }
            const result = await this.repository.transaction(async db => {
                const repeated = await this.recoverClaim(db, token, requestId);
                if (repeated === false) return null;
                if (repeated) return repeated;
                if (await this.currentDevice(db, device, token, true)) return null;
                // Retirement owns the project before its cascades: never hold role/member/session locks while waiting for it.
                if (!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [candidate.project_id])).rowCount) return null;
                const occupied = await db.query<{ count: string }>(`SELECT count(*) FROM system_role_mcp_sessions
                    WHERE state='open' AND claimed_at IS NOT NULL AND deadline_at>clock_timestamp()
                    AND target->>'runtime'='device' AND target->>'deviceId'=$1 AND owner_email=$2`, [device.id, device.email]);
                if (Number(occupied.rows[0].count) >= 2) return null;
                const session = (await db.query<McpSessionRow>(`SELECT * FROM system_role_mcp_sessions
                    WHERE state='open' AND claimed_at IS NULL AND deadline_at>clock_timestamp()
                    AND target->>'runtime'='device' AND target->>'deviceId'=$1 AND owner_email=$2 AND id=$3
                    ORDER BY created_at,id LIMIT 1`, [device.id, device.email, candidate.id])).rows[0];
                if (!session) return undefined;
                if (!session.worker_lease || session.job_id !== session.id) return conflict();
                try { await this.authority(session, db); }
                catch (error) {
                    if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error;
                    return false;
                }
                const claimed = (await db.query<McpSessionRow>(`UPDATE system_role_mcp_sessions SET claimed_at=clock_timestamp(),worker_claim_request_id=$2,worker_claim_token_hash=$3,
                    worker_lease_until=LEAST(deadline_at,clock_timestamp()+interval '30 seconds')
                    WHERE id=$1 AND state='open' AND claimed_at IS NULL AND deadline_at>clock_timestamp() RETURNING *`, [session.id, requestId, digest(token as string)])).rows[0];
                if (!claimed) return conflict();
                return { id: claimed.id, lease: claimed.worker_lease!, requestId, kind: SYSTEM_ROLE_MCP_JOB, project_id: claimed.project_id, payload: { sessionId: claimed.id } };
            });
            // Retire only the denied, still-unclaimed candidate; another worker may have won meanwhile.
            if (result === false) { await this.closeSession(candidate.id, true); continue; }
            if (result && typeof result === 'object' && 'recoveryOnly' in result) this.releaseDeviceSession(result.id);
            if (result !== undefined) return result;
        }
        return null;
    }

    async authorize(token: unknown, input: unknown) {
        const value = this.input(input), device = await this.devices.identity(token);
        await this.prepare(device, value);
        return this.repository.transaction(async db => {
            const session = await this.bound(db, device, value);
            if (session.state === 'closed') return { closed: true };
            this.live(session); await this.currentDevice(db, device, token); await this.authority(session, db);
            if (!(await db.query(`UPDATE system_role_mcp_sessions SET worker_lease_until=LEAST(deadline_at,clock_timestamp()+interval '30 seconds')
                WHERE id=$1 AND worker_lease=$2 AND state='open' AND deadline_at>clock_timestamp() AND worker_lease_until>clock_timestamp() RETURNING id`, [session.id, value.lease])).rowCount) return conflict();
            return { ok: true, closed: false };
        });
    }

    async context(token: unknown, input: unknown): Promise<RoleMcpSessionContext> {
        const value = this.input(input), device = await this.devices.identity(token);
        await this.prepare(device, value);
        return this.repository.transaction(async db => {
            const session = await this.bound(db, device, value); this.live(session);
            await this.currentDevice(db, device, token); await this.authority(session, db); this.live(await this.repository.session(session.id, db));
            return { sessionId: session.id, jobId: session.job_id, projectId: session.project_id, target: session.target, package: session.package,
                ...(session.install_set ? { installSet: session.install_set } : {}), deadlineAt: new Date(session.deadline_at).toISOString() };
        });
    }

    async next(token: unknown, input: unknown) {
        const value = this.input(input), device = await this.devices.identity(token);
        await this.prepare(device, value);
        return this.repository.transaction(async db => {
            const session = await this.bound(db, device, value);
            if (session.state === 'closed') return { closed: true };
            this.live(session); await this.currentDevice(db, device, token); await this.authority(session, db);
            const current = await this.repository.session(session.id, db); if (current.state === 'closed') return { closed: true }; this.live(current);
            const row = (await db.query<McpCallRow>(`SELECT * FROM system_role_mcp_calls WHERE session_id=$1 AND state='queued'
                AND deadline_at>clock_timestamp() ORDER BY created_at,id LIMIT 1`, [session.id])).rows[0];
            return row ? mcpCallContext(row) : null;
        });
    }

    async dispatch(token: unknown, input: unknown) {
        const value = this.input(input, 'dispatch'), device = await this.devices.identity(token);
        const session = await this.repository.transaction(async db => {
            const current = await this.bound(db, device, value); this.live(current);
            await this.currentDevice(db, device, token); await this.authority(current, db); this.live(await this.repository.session(current.id, db));
            const call = await this.repository.call(value.callId!, db);
            if (call.session_id !== current.id || call.state !== 'queued' || !future(call.deadline_at)) return conflict();
            return current;
        });
        // The service rechecks this worker fence in the same transaction as its one-send dispatch marker.
        return this.dispatchCall(value.callId!, { sessionId: session.id, lease: value.lease, deviceId: device.id });
    }

    async result(token: unknown, input: unknown) {
        const value = this.input(input, 'result'), session = await this.receipt(token, value);
        const call = await this.repository.call(value.callId!);
        if (call.session_id !== session.id) return conflict();
        let result: RoleMcpExecutionResult;
        try { result = normalizeRoleMcpResult(value.result, call.kind); }
        catch { throw new BadRequestException('Проверьте формат подтверждения инструмента.'); }
        await this.repository.finish(call.id, result);
        if (call.kind === 'list') await this.closeSession(session.id);
        return { ok: true };
    }

    async complete(token: unknown, input: unknown) {
        const value = this.input(input, 'complete'), session = await this.receipt(token, value), result = value.result;
        if (!object(result) || Object.keys(result).sort().join(',') !== 'closed,schemaVersion,sessionId'
            || result.schemaVersion !== 1 || result.sessionId !== session.id || result.closed !== true) throw new BadRequestException('Нужно подтверждение закрытия этой сессии MCP.');
        await this.repository.acknowledgeDeviceClosed(session.id, value.lease, digest(token as string));
        this.releaseDeviceSession(session.id);
        return { ok: true, closed: true };
    }

    private input(value: unknown, kind: 'base' | 'dispatch' | 'result' | 'complete' = 'base'): LeaseInput {
        const required = ['jobId', 'lease', ...(['dispatch', 'result'].includes(kind) ? ['callId'] : []), ...(['result', 'complete'].includes(kind) ? ['result'] : [])];
        const allowed = [...required, ...(kind === 'complete' ? ['state', 'message'] : [])];
        if (!object(value) || required.some(key => value[key] === undefined) || Object.keys(value).some(key => !allowed.includes(key))
            || !uuid(value.jobId) || !uuid(value.lease) || ['dispatch', 'result'].includes(kind) && !uuid(value.callId)
            || value.state !== undefined && !['succeeded', 'failed'].includes(String(value.state))
            || value.message !== undefined && (typeof value.message !== 'string' || Buffer.byteLength(value.message) > 2048 || value.message.includes('\0'))) throw new BadRequestException('Нужны точная сессия MCP, аренда и поля операции.');
        return value as unknown as LeaseInput;
    }

    private async bound(db: Db, device: Device, value: LeaseInput): Promise<McpSessionRow> {
        const session = await this.repository.session(value.jobId, db);
        if (session.target.runtime !== 'device' || session.target.deviceId !== device.id || session.owner_email !== device.email
            || session.job_id !== session.id || session.worker_lease !== value.lease || !session.claimed_at) return conflict();
        return session;
    }
    private async prepare(device: Device, input: LeaseInput): Promise<void> {
        const session = await this.bound(this.repository.pool, device, input);
        if (session.state === 'open') await this.preflight?.(session);
    }
    private live(session: McpSessionRow): void { if (session.state !== 'open' || !future(session.deadline_at) || !future(session.worker_lease_until)) conflict(); }
    private async currentDevice(db: Db, device: Device, token: unknown, exclusive = false): Promise<boolean> {
        const row = typeof token === 'string' ? (await db.query<{ paused: boolean;report_unavailable:boolean }>(`SELECT id,paused_until>clock_timestamp() AS paused,report->>'reportUnavailable'='true' AS report_unavailable FROM bridge_devices WHERE id=$1 AND email=$2 AND token_hash=$3
            AND NOT revoked AND expires_at>clock_timestamp() FOR ${exclusive ? 'UPDATE' : 'SHARE'}`, [device.id, device.email, digest(token)])).rows[0] : undefined;
        if (!row) throw new UnauthorizedException('Подключение MCP истекло или отозвано.');
        return row.paused === true||exclusive&&row.report_unavailable===true;
    }
    /** Replaying a durable preclaim intent retires execution; it never allocates work or asserts physical cleanup. */
    private async recoverClaim(db: Db, token: unknown, requestId: string, retireUnknown = false) {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Подтверждение MCP не принадлежит этому подключению.');
        const tokenHash = digest(token), device = (await db.query<{ id: string; email: string }>('SELECT id,email FROM bridge_devices WHERE token_hash=$1 FOR UPDATE', [tokenHash])).rows[0];
        if (!device) throw new UnauthorizedException('Подтверждение MCP не принадлежит этому подключению.');
        const session = (await db.query<McpSessionRow>(`SELECT * FROM system_role_mcp_sessions WHERE target->>'runtime'='device'
            AND target->>'deviceId'=$1 AND owner_email=$2 AND worker_claim_request_id=$3 AND worker_claim_token_hash=$4
            AND claimed_at IS NOT NULL FOR NO KEY UPDATE`, [device.id, device.email, requestId, tokenHash])).rows[0];
        if (retireUnknown || session) await db.query(`INSERT INTO system_role_mcp_retired_claims(device_id,token_hash,request_id)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [device.id, tokenHash, requestId]);
        if (!session) return (await db.query('SELECT 1 FROM system_role_mcp_retired_claims WHERE device_id=$1 AND token_hash=$2 AND request_id=$3', [device.id, tokenHash, requestId])).rowCount ? false : null;
        await db.query("UPDATE system_role_mcp_sessions SET state='closed' WHERE id=$1", [session.id]);
        await db.query("UPDATE system_role_mcp_calls SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,completed_at=now() WHERE session_id=$1 AND state IN ('queued','dispatched')", [session.id]);
        return { id: session.id, lease: session.worker_lease!, requestId, recoveryOnly: true as const, kind: SYSTEM_ROLE_MCP_JOB, project_id: session.project_id, payload: { sessionId: session.id } };
    }
    /** A stored token hash and immutable lease accept only receipts after revocation, never new execution. */
    private async receipt(token: unknown, value: LeaseInput): Promise<McpSessionRow> {
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new UnauthorizedException('Подтверждение MCP не принадлежит этому подключению.');
        const session = (await this.repository.pool.query<McpSessionRow>(`SELECT s.* FROM system_role_mcp_sessions s JOIN bridge_devices d
            ON d.id::text=s.target->>'deviceId' AND d.email=s.owner_email WHERE s.id=$1 AND s.job_id=s.id::text AND s.worker_lease=$2
            AND s.claimed_at IS NOT NULL AND s.target->>'runtime'='device' AND d.token_hash=$3`, [value.jobId, value.lease, digest(token)])).rows[0];
        if (!session) throw new UnauthorizedException('Подтверждение MCP не принадлежит этой сессии.');
        return session;
    }
}
