import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { SystemRoleMcpRepository } from '../src/system-role-mcp/system-role-mcp.repository';
import { SystemRoleMcpChannel } from '../src/system-role-mcp/system-role-mcp.channel';
import { digest } from '../src/devices/device-store';

const connection = process.env.SYSTEM_ROLE_MCP_CHANNEL_TEST_ADMIN_URL;
/** Native SQL receipt boundary only: this deliberately does not claim full MCP migration/transport acceptance. */
describe.skipIf(!connection).sequential('MCP private receipt SQL on caller-owned PostgreSQL; no transport', () => {
    let admin: Pool | undefined, pool: Pool | undefined, database: string | undefined, channel: SystemRoleMcpChannel;
    const token = 'a'.repeat(64), sessionId = randomUUID(), lease = randomUUID(), deviceId = randomUUID(), foreignId = randomUUID();
    const identity = vi.fn(async () => { throw new Error('Late receipt must not request fresh authority'); }), authority = vi.fn(identity), close = vi.fn(async () => undefined);
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_mcp_receipt_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({ connectionString: url.href, max: 1 });
        // Minimal physical join boundaries retain the production UUID session key and text job key.
        await pool.query(`CREATE TABLE bridge_devices(id uuid PRIMARY KEY,email text NOT NULL,token_hash text NOT NULL,revoked boolean NOT NULL,expires_at timestamptz NOT NULL);
            CREATE TABLE system_role_mcp_sessions(id uuid PRIMARY KEY,owner_email text NOT NULL,job_id text NOT NULL,worker_lease uuid NOT NULL,claimed_at timestamptz NOT NULL,target jsonb NOT NULL,state text NOT NULL DEFAULT 'open',worker_closed_at timestamptz);
            CREATE TABLE system_role_mcp_calls(id uuid PRIMARY KEY,session_id uuid,state text,completed_at timestamptz)`);
        await pool.query("INSERT INTO bridge_devices VALUES($1,$2,$3,true,now()-interval '1 day')", [deviceId, 'owner@test', digest(token)]);
        await pool.query('INSERT INTO system_role_mcp_sessions(id,owner_email,job_id,worker_lease,claimed_at,target) VALUES($1,$2,$3,$4,now(),$5::jsonb)', [sessionId, 'owner@test', sessionId, lease, JSON.stringify({ runtime: 'device', deviceId })]);
        channel = new SystemRoleMcpChannel(new SystemRoleMcpRepository(pool), { identity } as never, authority, async () => { throw new Error('Receipt cannot dispatch'); }, close);
    });
    afterAll(async () => {
        await pool?.end();
        if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } }
    });
    it('accepts the matching UUID/text receipt after device revocation and token expiry without fresh ACL', async () => {
        const body = { jobId: sessionId, lease, state: 'succeeded', message: 'Session closed', result: { schemaVersion: 1, sessionId, closed: true } };
        expect(await channel.complete(token, body)).toEqual({ ok: true, closed: true }); expect(close).not.toHaveBeenCalled();
        expect(identity).not.toHaveBeenCalled(); expect(authority).not.toHaveBeenCalled();
        expect((await pool!.query('SELECT state,worker_closed_at FROM system_role_mcp_sessions WHERE id=$1',[sessionId])).rows[0]).toMatchObject({state:'closed',worker_closed_at:expect.any(Date)});
    });
    it('rejects a foreign lease, token, source session or device target without closing another session', async () => {
        const previous = close.mock.calls.length, body = { jobId: sessionId, lease, result: { schemaVersion: 1, sessionId, closed: true } };
        await expect(channel.complete('b'.repeat(64), body)).rejects.toHaveProperty('status', 401);
        await expect(channel.complete(token, { ...body, lease: foreignId })).rejects.toHaveProperty('status', 401);
        await expect(channel.complete(token, { ...body, result: { ...body.result, sessionId: foreignId } })).rejects.toHaveProperty('status', 400);
        await pool!.query('UPDATE system_role_mcp_sessions SET target=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ runtime: 'device', deviceId: foreignId })]);
        try { await expect(channel.complete(token, body)).rejects.toHaveProperty('status', 401); }
        finally { await pool!.query('UPDATE system_role_mcp_sessions SET target=$2::jsonb WHERE id=$1', [sessionId, JSON.stringify({ runtime: 'device', deviceId })]); }
        expect(close).toHaveBeenCalledTimes(previous);
    });
});
