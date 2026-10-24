import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { SYSTEM_ROLE_MCP_LIMITS as limits, systemRoleMcpDigest, type RoleMcpExecutionResult, type RoleMcpTarget } from '../../../shared/system-role-mcp.cjs';
import type { IPackage } from '../catalog/bundle-package';
import type { IInstallationSet } from '../devices/installation-set';
import type { RoleRunRow } from '../system-roles/system-role.types';
import type { McpCallRow, McpDiscoveryRow, McpSessionRow } from './system-role-mcp.store-types';

type Db = Pick<PoolClient, 'query'>;
type SessionInput = { owner: string; role: string; project: string; target: RoleMcpTarget; package: IPackage; installSet?: IInstallationSet; run?: RoleRunRow };
/** The private MCP channel owns one-send leases; it never occupies the general device-job lane. */
export class SystemRoleMcpRepository {
    constructor(readonly pool: Pool) {}
    async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
        const db = await this.pool.connect();
        try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
        catch (error) { await db.query('ROLLBACK').catch(() => undefined); throw error; } finally { db.release(); }
    }
    /** Device revocation precedes project retirement; child authority locks are taken only after both fences. */
    private async lockScope(db: Db, project: string, target: RoleMcpTarget): Promise<void> {
        if (target.runtime === 'device') await db.query('SELECT id FROM bridge_devices WHERE id=$1 FOR SHARE', [target.deviceId]);
        if (!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [project])).rowCount) throw new ConflictException('Проект недоступен.');
    }
    async session(id: string, db: Db = this.pool, lock = false): Promise<McpSessionRow> {
        const row = (await db.query<McpSessionRow>('SELECT * FROM system_role_mcp_sessions WHERE id=$1' + (lock ? ' FOR NO KEY UPDATE' : ''), [id])).rows[0];
        if (!row) throw new NotFoundException('Сессия инструментов недоступна.'); return row;
    }
    async call(id: string, db: Db = this.pool, lock = false): Promise<McpCallRow> {
        const row = (await db.query<McpCallRow>('SELECT * FROM system_role_mcp_calls WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
        if (!row) throw new NotFoundException('Квитанция инструмента недоступна.'); return row;
    }
    async discovery(id: string, owner: string, db: Db = this.pool): Promise<McpDiscoveryRow | undefined> {
        return (await db.query<McpDiscoveryRow>('SELECT * FROM system_role_mcp_discoveries WHERE id=$1 AND owner_email=$2', [id, owner])).rows[0];
    }
    private async open(db: Db, input: SessionInput): Promise<McpSessionRow> {
        const targetHash = systemRoleMcpDigest(input.target);
        if (input.run) {
            const old = (await db.query<McpSessionRow>('SELECT * FROM system_role_mcp_sessions WHERE run_id=$1 AND lease_token=$2 AND target_hash=$3 FOR NO KEY UPDATE', [input.run.id, input.run.lease_token, targetHash])).rows[0];
            if (old) { if (old.state !== 'open' || new Date(old.deadline_at).getTime() <= Date.now()) throw new ConflictException('Сессия инструмента завершена. Автоматического повтора нет.'); return old; }
        }
        const id = randomUUID(), local = input.target.runtime === 'device';
        return (await db.query<McpSessionRow>(`INSERT INTO system_role_mcp_sessions(id,owner_email,actor_role,project_id,run_id,lease_token,target_hash,target,package,install_set,job_id,worker_lease,deadline_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,LEAST(now()+($13::int*interval '1 millisecond'),COALESCE($14::timestamptz,'infinity'))) RETURNING *`,
        [id, input.owner, input.role, input.project, input.run?.id ?? null, input.run?.lease_token ?? null, targetHash, JSON.stringify(input.target), JSON.stringify(input.package), input.installSet ? JSON.stringify(input.installSet) : null, local ? id : null, local ? randomUUID() : null, limits.sessionMs, input.run?.lease_until ?? null])).rows[0];
    }
    private async insertCall(db: Db, session: McpSessionRow, kind: 'list' | 'call', tool?: { key: string; name: string; digest: string; arguments: Record<string, unknown> }): Promise<McpCallRow> {
        return (await db.query<McpCallRow>(`INSERT INTO system_role_mcp_calls(id,session_id,run_id,kind,dispatch_proof,tool_key,name,schema_digest,arguments,deadline_at)
            VALUES($1,$2,$3,$4,$11,$5,$6,$7,$8::jsonb,LEAST($9::timestamptz,now()+($10::int*interval '1 millisecond'))) RETURNING *`,
        [randomUUID(), session.id, session.run_id, kind, tool?.key ?? null, tool?.name ?? null, tool?.digest ?? null, tool ? JSON.stringify(tool.arguments) : null, session.deadline_at, limits.callMs, randomBytes(32).toString('hex')])).rows[0];
    }
    async discover(id: string, hash: string, input: SessionInput, authorize: (db: Db) => Promise<void>) {
        return this.transaction(async db => {
            await this.lockScope(db, input.project, input.target);
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('system-role-mcp-discovery:'||$1,0))", [input.owner + ':' + id]);
            const old = await this.discovery(id, input.owner, db);
            if (old) { if (old.request_hash !== hash) throw new ConflictException('Ключ обнаружения относится к другому выбору.'); return { discovery: old, session: await this.session(old.session_id, db), call: await this.call(old.call_id, db), created: false }; }
            await authorize(db);
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('system-role-mcp-discovery-capacity',0))");
            if (Number((await db.query<{ count: string }>("SELECT count(*) FROM system_role_mcp_discoveries d JOIN system_role_mcp_sessions s ON s.id=d.session_id WHERE d.owner_email=$1 AND s.state='open' AND s.deadline_at>now()", [input.owner])).rows[0].count) >= 2) throw new ConflictException('Дождитесь текущего обнаружения инструментов.');
            if (Number((await db.query<{ count: string }>("SELECT count(*) FROM system_role_mcp_sessions WHERE run_id IS NULL AND state='open' AND deadline_at>now()")).rows[0].count) >= 8) throw new ConflictException('Обнаружение MCP занято. Повторите проверку после завершения текущих сессий.');
            const session = await this.open(db, input), call = await this.insertCall(db, session, 'list');
            const discovery = (await db.query<McpDiscoveryRow>(`INSERT INTO system_role_mcp_discoveries(id,owner_email,actor_role,project_id,request_hash,target,session_id,call_id,expires_at)
                VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now()+($9::int*interval '1 millisecond')) RETURNING *`, [id, input.owner, input.role, input.project, hash, JSON.stringify(input.target), session.id, call.id, limits.discoveryTtlMs])).rows[0];
            return { discovery, session, call, created: true };
        });
    }
    async enqueue(input: SessionInput & { run: RoleRunRow }, tool: { key: string; name: string; digest: string; arguments: Record<string, unknown> }, authorize: (db: Db, current: RoleRunRow) => Promise<void>) {
        return this.transaction(async db => {
            await this.lockScope(db, input.project, input.target);
            const current = (await db.query<RoleRunRow>("SELECT * FROM system_role_runs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() FOR NO KEY UPDATE", [input.run.id, input.run.lease_token])).rows[0];
            if (!current) throw new ConflictException('Запуск инструмента отменён или потерял аренду.'); await authorize(db, current);
            if (Number((await db.query<{ count: string }>("SELECT count(*) FROM system_role_mcp_calls WHERE run_id=$1 AND kind='call'", [current.id])).rows[0].count) >= limits.calls) throw new ConflictException('Лимит вызовов инструментов исчерпан.');
            const session = await this.open(db, { ...input, run: current });
            const call = await this.insertCall(db, session, 'call', tool); return { session, call };
        });
    }
    async dispatch(id: string, authorize: (db: Db, session: McpSessionRow, call: McpCallRow) => Promise<void>) {
        return this.transaction(async db => {
            const observed = await this.call(id, db);
            const source = await this.session(observed.session_id, db);
            await this.lockScope(db, source.project_id, source.target);
            if (observed.run_id) await db.query('SELECT id FROM system_role_runs WHERE id=$1 FOR NO KEY UPDATE', [observed.run_id]);
            const session = await this.session(observed.session_id, db, true), call = await this.call(id, db, true);
            if (session.state !== 'open' || new Date(session.deadline_at).getTime() <= Date.now() || new Date(call.deadline_at).getTime() <= Date.now() || call.state !== 'queued') throw new ConflictException('Отправка инструмента уже началась или отменена. Повтор не выполняется.');
            await authorize(db, session, call);
            await db.query("UPDATE system_role_mcp_calls SET state='dispatched',dispatched_at=now() WHERE id=$1 AND state='queued'", [id]); return { ok: true };
        });
    }
    async finish(id: string, result: RoleMcpExecutionResult): Promise<McpCallRow> {
        return this.transaction(async db => {
            const call = await this.call(id, db, true);
            const session = await this.session(call.session_id, db);
            const active = session.run_id ? (await db.query("SELECT id FROM system_role_runs WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()", [session.run_id, session.lease_token])).rowCount : 1;
            const expired = session.state !== 'open' || new Date(session.deadline_at).getTime() <= Date.now() || new Date(call.deadline_at).getTime() <= Date.now()
                || session.claimed_at && (!session.worker_lease_until || new Date(session.worker_lease_until).getTime() <= Date.now()) || !active;
            if (expired && ['queued', 'dispatched'].includes(call.state)) return (await db.query<McpCallRow>("UPDATE system_role_mcp_calls SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,late_result=$2::jsonb,completed_at=now() WHERE id=$1 RETURNING *", [id, JSON.stringify(result)])).rows[0];
            if (!['queued', 'dispatched'].includes(call.state)) {
                if (!['unknown', 'cancelled'].includes(call.state) && call.result && systemRoleMcpDigest(call.result) !== systemRoleMcpDigest(result)) throw new ConflictException('Квитанция вызова уже сохранена с другим результатом.');
                if (call.late_result && systemRoleMcpDigest(call.late_result) !== systemRoleMcpDigest(result)) throw new ConflictException('Поздняя квитанция уже сохранена с другим результатом.');
                if (call.state === 'unknown' || call.state === 'cancelled') await db.query('UPDATE system_role_mcp_calls SET late_result=$2::jsonb WHERE id=$1 AND late_result IS NULL', [id, JSON.stringify(result)]);
                return call;
            }
            if (call.state === 'queued' && result.state === 'succeeded') throw new ConflictException('Отправка инструмента не подтверждена.');
            const state = call.state === 'queued' ? 'failed' : result.state;
            return (await db.query<McpCallRow>('UPDATE system_role_mcp_calls SET state=$2,result=$3::jsonb,completed_at=now() WHERE id=$1 RETURNING *', [id, state, JSON.stringify(result)])).rows[0];
        });
    }
    /** A retained device token and exact lease can acknowledge cleanup without regaining execution authority. */
    async acknowledgeDeviceClosed(id: string, lease: string, tokenHash: string): Promise<void> {
        await this.transaction(async db => {
            // Match maintenance/claim ordering: the device lock always precedes the session lock.
            const device = (await db.query<{ id: string; email: string }>('SELECT id,email FROM bridge_devices WHERE token_hash=$1 FOR SHARE', [tokenHash])).rows[0];
            if (!device) throw new UnauthorizedException('Подтверждение MCP не принадлежит этому подключению.');
            const session = await this.session(id, db, true);
            if (session.target.runtime !== 'device' || session.target.deviceId !== device.id || session.owner_email !== device.email
                || session.job_id !== session.id || session.worker_lease !== lease || !session.claimed_at) throw new UnauthorizedException('Подтверждение MCP не принадлежит этой сессии.');
            if (session.worker_claim_request_id && session.worker_claim_token_hash) await db.query(`INSERT INTO system_role_mcp_retired_claims(device_id,token_hash,request_id)
                VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [device.id, session.worker_claim_token_hash, session.worker_claim_request_id]);
            await db.query("UPDATE system_role_mcp_sessions SET state='closed',worker_closed_at=COALESCE(worker_closed_at,clock_timestamp()) WHERE id=$1", [id]);
            await db.query("UPDATE system_role_mcp_calls SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,completed_at=now() WHERE session_id=$1 AND state IN ('queued','dispatched')", [id]);
        });
    }
    /** Rejected queue candidates cannot close a session already leased by another worker. */
    async close(id: string, onlyUnclaimed = false): Promise<McpSessionRow> {
        return this.transaction(async db => {
            const session = await this.session(id, db, true);
            if (onlyUnclaimed && (session.state !== 'open' || session.claimed_at)) return session;
            await db.query("UPDATE system_role_mcp_sessions SET state='closed' WHERE id=$1", [id]);
            if (onlyUnclaimed) {
                await db.query("UPDATE system_role_mcp_calls SET state='failed',result=$2::jsonb,completed_at=now() WHERE session_id=$1 AND state='queued'", [id,
                    JSON.stringify({ state: 'failed', message: 'Подключение MCP изменилось или новые вызовы отключены. Обновите список инструментов.' })]);
            } else {
                await db.query("UPDATE system_role_mcp_calls SET state=CASE WHEN state='dispatched' THEN 'unknown' ELSE 'cancelled' END,completed_at=now() WHERE session_id=$1 AND state IN ('queued','dispatched')", [id]);
            }
            return { ...session, state: 'closed' };
        });
    }
}
