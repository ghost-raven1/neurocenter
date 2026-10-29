import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, expect, it, vi } from 'vitest';
import { SystemRoleMcpChannel } from '../src/system-role-mcp/system-role-mcp.channel';
import type { McpCallRow, McpSessionRow } from '../src/system-role-mcp/system-role-mcp.store-types';
import { digest } from '../src/devices/device-store';

const token = 'a'.repeat(64), id = '11111111-1111-4111-8111-111111111111', lease = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333', callId = '44444444-4444-4444-8444-444444444444';
const foreignId = '55555555-5555-4555-8555-555555555555';
const claimRequestId = '66666666-6666-4666-8666-666666666666', claimInput={requestId:claimRequestId,recoveryOnly:false};
const base = { jobId: id, lease }, later = () => new Date(Date.now() + 120000);
/** Stored rows model repository/device boundaries; no model, shared job queue or real device is invoked. */
function fixture() {
    const device = { id: deviceId, email: 'owner@test', role: 'Админ проекта' };
    const session = { id, owner_email: device.email, actor_role: device.role, project_id: 'prj-one', run_id: null, lease_token: null,
        target: { runtime: 'device', assetId: 'asset-one', version: 1, manifest: 'b'.repeat(64), deviceId, bindingId: 'binding', instanceId: 'instance', configurationRevisions: [] },
        package: { immutable: 'package' }, install_set: null, job_id: id, worker_lease: lease, worker_lease_until: later(), claimed_at: new Date(), state: 'open', deadline_at: later(), created_at: new Date() } as unknown as McpSessionRow;
    const call = { id: callId, session_id: id, run_id: null, kind: 'list', name: null, schema_digest: null, arguments: null, state: 'dispatched', deadline_at: later() } as McpCallRow;
    const state = { revoked: false, occupied: 0, reportUnavailable:false,events: [] as string[] };
    const identity = vi.fn(async () => { if (state.revoked) throw new UnauthorizedException(); return device; });
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SELECT s.* FROM system_role_mcp_sessions s JOIN bridge_devices')) return { rows: params[0] === id && params[1] === lease && params[2] === digest(token) ? [session] : [], rowCount: 1 };
        if (sql.includes('FROM bridge_devices')) return { rows: state.revoked ? [] : [{ id: deviceId, email:device.email,report_unavailable:state.reportUnavailable }], rowCount: state.revoked ? 0 : 1 };
        if (sql.includes('FROM system_role_mcp_retired_claims')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM projects')) return { rows: [{id:'prj-one'}], rowCount: 1 };
        if (sql.includes('SELECT count(*)')) return { rows: [{ count: String(state.occupied) }], rowCount: 1 };
        if (sql.includes('worker_claim_request_id=$3')) return { rows: session.worker_claim_request_id===params[2] && session.worker_claim_token_hash===params[3] ? [session] : [],rowCount:0 };
        if (sql.includes('SELECT * FROM system_role_mcp_sessions')) return { rows: !session.claimed_at && session.owner_email === params[1] ? [session] : [], rowCount: 1 };
        if (sql.includes('SET claimed_at=')) {
            state.events.push('claim'); if (session.state !== 'open' || session.claimed_at) return { rows: [], rowCount: 0 };
            session.claimed_at = new Date(); session.worker_claim_request_id=String(params[1]);session.worker_claim_token_hash=String(params[2]);session.worker_lease_until = later(); return { rows: [session], rowCount: 1 };
        }
        if (sql.includes('SET worker_lease_until=')) { state.events.push('renew'); return { rows: [{ id }], rowCount: 1 }; }
        if (sql.includes('FROM system_role_mcp_calls')) return { rows: call.state === 'queued' ? [call] : [], rowCount: 1 };
        throw new Error('Unexpected boundary query');
    });
    const repository = { pool: { query }, transaction: async work => work({ query }), session: vi.fn(async () => session), call: vi.fn(async () => call), finish: vi.fn(async () => call), acknowledgeDeviceClosed: vi.fn(async () => { session.state = 'closed'; session.worker_closed_at = new Date(); }) };
    const authority = vi.fn(async () => { state.events.push('authority'); });
    const releaseDeviceSession=vi.fn();
    const dispatch = vi.fn(async () => ({ ok: true })), close = vi.fn(async () => { session.state = 'closed'; return session; });
    const channel = new SystemRoleMcpChannel(repository as never, { identity } as never, authority, dispatch, close,undefined,releaseDeviceSession);
    return { channel, session, call, state, query, identity, authority, dispatch, close, repository, releaseDeviceSession };
}
beforeEach(() => vi.clearAllMocks());
it.each([undefined,{}, {requestId:'bad',recoveryOnly:false}, {...claimInput,extra:true}])('rejects an invalid preclaim intent before touching authority or SQL: %j',async input=>{
    const f=fixture();await expect(f.channel.claim(token,input)).rejects.toHaveProperty('status',400);expect(f.identity).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
});
it('claims a private session after fresh authority and returns identifiers without executable context or the general job queue', async () => {
    const f = fixture(); f.session.claimed_at = null;
    expect(await f.channel.claim(token,claimInput)).toEqual({ id, lease, requestId:claimRequestId, kind: 'system-role-mcp-session', project_id: 'prj-one', payload: { sessionId: id } });
    expect(f.state.events).toEqual(['authority', 'claim']); expect(f.identity).toHaveBeenCalledWith(token); expect(f.query.mock.calls.map(call => call[0]).join('\n')).not.toContain('bridge_jobs');
});
it('degraded admission blocks an unclaimed session while preserving active authorization and fresh authority',async()=>{
    const f=fixture();f.state.reportUnavailable=true;
    expect(await f.channel.authorize(token,base)).toEqual({ok:true,closed:false});expect(f.authority).toHaveBeenCalledOnce();
    f.authority.mockClear();f.session.claimed_at=null;
    expect(await f.channel.claim(token,claimInput)).toBeNull();expect(f.session.claimed_at).toBeNull();expect(f.authority).not.toHaveBeenCalled();
    f.state.reportUnavailable=false;expect(await f.channel.claim(token,claimInput)).toMatchObject({id,lease});
});
it('two already claimed open MCP sessions fill only this device private lane and prevent another claim', async () => {
    const f = fixture(); f.session.claimed_at = null; f.state.occupied = 2;
    expect(await f.channel.claim(token,claimInput)).toBeNull(); expect(f.authority).not.toHaveBeenCalled(); expect(f.state.events).toEqual([]);
});
it('another owner has no claimable candidate on this device', async () => {
    const f = fixture(); f.session.claimed_at = null; f.session.owner_email = 'other@test';
    expect(await f.channel.claim(token,claimInput)).toBeNull(); expect(f.authority).not.toHaveBeenCalled();
});
it('a concurrent close during authority cannot turn the immutable candidate into a claimed session', async () => {
    const f = fixture(); f.session.claimed_at = null; f.authority.mockImplementation(async () => { f.session.state = 'closed'; });
    await expect(f.channel.claim(token,claimInput)).rejects.toHaveProperty('status', 409); expect(f.session.claimed_at).toBeNull();
});
it('authorize renews a live lease after authority and a closed matching session does not request new authority', async () => {
    const f = fixture(); expect(await f.channel.authorize(token, base)).toEqual({ ok: true, closed: false }); expect(f.state.events).toEqual(['authority', 'renew']);
    f.session.state = 'closed'; f.authority.mockRejectedValue(new ForbiddenException()); expect(await f.channel.authorize(token, base)).toEqual({ closed: true }); expect(f.authority).toHaveBeenCalledOnce();
});
it('context is immutable private package data and next returns only the current session earliest queued call', async () => {
    const f = fixture(); const context = await f.channel.context(token, base); expect(context).toMatchObject({ sessionId: id, jobId: id, projectId: 'prj-one', package: f.session.package, target: f.session.target });
    f.call.state = 'queued'; expect(await f.channel.next(token, base)).toEqual({ id: callId, kind: 'list', deadlineAt: new Date(f.call.deadline_at).toISOString() });
    f.session.state = 'closed'; expect(await f.channel.next(token, base)).toEqual({ closed: true });
});
it.each(['expired lease', 'expired session', 'revoked device', 'revoked authority', 'wrong lease', 'wrong device', 'server session'])('blocks new execution for %s', async reason => {
    const f = fixture(); let input = base;
    if (reason === 'expired lease') f.session.worker_lease_until = new Date(0);
    if (reason === 'expired session') f.session.deadline_at = new Date(0);
    if (reason === 'revoked device') f.state.revoked = true;
    if (reason === 'revoked authority') f.authority.mockRejectedValue(new ForbiddenException());
    if (reason === 'wrong lease') input = { ...base, lease: foreignId };
    if (reason === 'wrong device') f.session.target = { ...f.session.target, deviceId: foreignId } as McpSessionRow['target'];
    if (reason === 'server session') f.session.target = { runtime: 'server', assetId: 'asset-one', version: 1, manifest: 'b'.repeat(64) };
    await expect(f.channel.context(token, input)).rejects.toBeDefined(); expect(f.dispatch).not.toHaveBeenCalled();
});
it('dispatch binds the exact session and provides the worker fence to the atomic one-send owner', async () => {
    const f = fixture(); f.call.state = 'queued'; await f.channel.dispatch(token, { ...base, callId });
    expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(callId, { sessionId: id, lease, deviceId }); f.dispatch.mockClear(); f.call.session_id = foreignId;
    await expect(f.channel.dispatch(token, { ...base, callId })).rejects.toHaveProperty('status', 409); expect(f.dispatch).not.toHaveBeenCalled();
});
it('late results use only the leased receipt identity after revocation and close discovery sessions after persistence', async () => {
    const f = fixture(); f.state.revoked = true; f.session.state = 'closed'; f.session.worker_lease_until = new Date(0); f.call.state = 'unknown';
    const result = { state: 'failed', message: 'Runtime stopped' }; expect(await f.channel.result(token, { ...base, callId, result })).toEqual({ ok: true });
    expect(f.identity).not.toHaveBeenCalled(); expect(f.authority).not.toHaveBeenCalled(); expect(f.repository.finish).toHaveBeenCalledExactlyOnceWith(callId, result); expect(f.close).toHaveBeenCalledWith(id);
});
it('successful list results close execution authority, while ordinary tool receipts leave the session open', async () => {
    const f = fixture(); const list = { state: 'succeeded', value: { tools: [] } }; await f.channel.result(token, { ...base, callId, result: list }); expect(f.close).toHaveBeenCalledExactlyOnceWith(id);
    f.close.mockClear(); f.call.kind = 'call'; const result = { state: 'succeeded', value: { text: 'Measured result', isError: false, truncated: false } };
    await f.channel.result(token, { ...base, callId, result }); expect(f.repository.finish).toHaveBeenLastCalledWith(callId, result); expect(f.close).not.toHaveBeenCalled();
});
it('late completion verifies its own source without fresh rights and closes only this private session', async () => {
    const f = fixture(); f.state.revoked = true; const result = { schemaVersion: 1, sessionId: id, closed: true };
    expect(await f.channel.complete(token, { ...base, state: 'succeeded', message: 'Session closed', result })).toEqual({ ok: true, closed: true }); expect(f.repository.acknowledgeDeviceClosed).toHaveBeenCalledExactlyOnceWith(id,lease,digest(token)); expect(f.releaseDeviceSession).toHaveBeenCalledExactlyOnceWith(id); expect(f.close).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled();
    await expect(f.channel.complete(token, { ...base, result: { ...result, sessionId: foreignId } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.channel.complete('c'.repeat(64), { ...base, result })).rejects.toHaveProperty('status', 401);
});
it('a receipt cannot acknowledge another session call or accept an invalid result schema', async () => {
    const f = fixture(); f.call.session_id = foreignId; await expect(f.channel.result(token, { ...base, callId, result: { state: 'failed', message: 'x' } })).rejects.toHaveProperty('status', 409);
    f.call.session_id = id; await expect(f.channel.result(token, { ...base, callId, result: { state: 'succeeded', value: { tools: 'fabricated' } } })).rejects.toHaveProperty('status', 400); expect(f.repository.finish).not.toHaveBeenCalled();
});
it.each([{ jobId: id, lease, extra: true }, { jobId: 'bad-id', lease }, { jobId: id, lease: 'bad-lease' }])('rejects malformed body before device authority: %j', async input => {
    const f = fixture(); await expect(f.channel.authorize(token, input)).rejects.toHaveProperty('status', 400); expect(f.identity).not.toHaveBeenCalled();
});
