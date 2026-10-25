import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosis, delegation, snippet, systemRoleRagPort } from './helpers/system-role-rag-port';
import { roleResult } from '../src/system-roles/system-role.validation';
import { roleSelection } from '../src/system-roles/system-role.validation';
import { ProjectEmbeddingRepository } from '../src/models/project-embedding.repository';
import { SystemRoleRepository } from '../src/system-roles/system-role.repository';
import type { Pool } from 'pg';
import { OllamaClient } from '../src/models/ollama-client';
import { embeddingModel } from './helpers/project-context-port';
import { normalizeRoleMcpTool, roleMcpToolKey } from '../../shared/system-role-mcp.cjs';
import type { SystemRoleId } from '../src/system-roles/system-role.types';
import type { ChatMessage } from '../src/model-chat/chat.types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const roles: SystemRoleId[] = ['agent-ai-admin', 'agent-autoconfigurator', 'agent-indexer', 'agent-packager'];

describe('Accepted project knowledge is distinct from selected target disclosure', () => {
    it('prepares free whole-index consent with exact identity, approved recipients and the shared call budget', async () => {
        const f = await systemRoleRagPort('agent-coordinator');
        expect(f.calls).toEqual([]); expect(f.prepared.projectContext).toMatchObject({ scope: 'project-index', projectId: f.project.id,
            snapshot: f.selected.activeSnapshot, recipients: expect.arrayContaining(['agent-coordinator', ...roles]) });
        expect(f.prepared.preview).toContain('project-index'); expect(f.prepared.preview).toContain('maxRetrievals');
        f.selected.dataRevision++;
        const next = await f.owner.prepare(f.req, 'agent-coordinator', f.row.snapshot.selection);
        expect(next.consentDigest).not.toBe(f.prepared.consentDigest); expect(f.calls).toEqual([]);
    });
    it.each(roles)('delivers useful cited fragments to %s through real retrieval and reserves exactly one embedding', async id => {
        const f = await systemRoleRagPort(id); await f.run();
        expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']); expect(f.row.calls_started).toBe(2);
        expect(f.row.result).toMatchObject({ findings: [{ evidenceId: 'source-one' }], projectContext: { status: 'ready', sources: [{ id: 'source-one', path: 'docs/unrelated-name.md', startLine: 3 }] } });
        expect(f.calls.every(call => call.requiredFeatures?.includes('project_search'))).toBe(true);
        expect(JSON.stringify(f.row.result)).not.toContain('PROJECT KNOWLEDGE');
    });
    it('does not grow an accepted initial-OFF context after search is enabled', async () => {
        const f = await systemRoleRagPort('agent-ai-admin', false); f.flags.project_search = true; await f.run();
        expect(f.prepared.projectContext).toBeUndefined(); expect(f.calls.map(call => call.endpoint)).toEqual(['chat']);
        expect(f.calls[0].requiredFeatures).not.toContain('project_search'); expect(f.row.result?.projectContext).toBeUndefined();
    });
    it('keeps legacy grantless accepted context ordinary and never captures a new read grant at checkpoints', async () => {
        const f = await systemRoleRagPort('agent-ai-admin', false); f.flags.project_search = true;
        await f.run(); expect(f.row.snapshot.projectContext).toBeUndefined();
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat']); expect(f.row.state).toBe('succeeded');
    });
    it('rejects a changed index after consent before any paid call rather than silently repinning', async () => {
        const f = await systemRoleRagPort(); f.selected.activeSnapshot = 'c'.repeat(64);
        await expect(f.run()).rejects.toMatchObject({ status: 409 }); expect(f.calls).toEqual([]); expect(f.row.result).toBeNull();
    });
    it('keeps a system-scope answer independent of every project index', async () => {
        const f = await systemRoleRagPort();
        await f.accept(await f.owner.prepare(f.req, 'agent-ai-admin', { ...f.row.snapshot.selection, projectId: null }));
        await f.run(); expect(f.calls.map(call => call.endpoint)).toEqual(['chat']); expect(f.row.result?.projectContext).toBeUndefined();
    });
    it('does not admit caller-supplied read grants or a foreign project through the role selection contract', async () => {
        const f = await systemRoleRagPort();
        expect(() => roleSelection('agent-ai-admin', { ...f.row.snapshot.selection, projectContext: f.prepared.projectContext })).toThrow();
        const foreign = { ...f.prepared.projectContext!, projectId: 'prj-other' };
        await expect(f.owner.prepare(f.req, 'agent-ai-admin', f.row.snapshot.selection, undefined, { projectContext: foreign })).rejects.toMatchObject({ status: 409 });
        expect(f.calls).toEqual([]);
    });
    it('rejects too-large mandatory selected context without buying an embedding to make it fit', async () => {
        const f = await systemRoleRagPort('agent-autoconfigurator');
        const work = async () => {
            await f.accept(await f.owner.prepare(f.req, 'agent-autoconfigurator', { ...f.row.snapshot.selection,
                targets: [{ kind: 'prompt', id: 'one', text: 'x'.repeat(32300) }, { kind: 'prompt', id: 'two', text: 'y'.repeat(32300) }] }));
            await f.run();
        };
        await expect(work()).rejects.toBeInstanceOf(Error); expect(f.calls).toEqual([]);
    });
    it('shares one approved retrieval while retaining direct target subsets and bounded coordinator calls', async () => {
        const f = await systemRoleRagPort('agent-coordinator', true, [{ kind: 'prompt', id: 'A', text: 'DIRECT_A' }, { kind: 'prompt', id: 'B', text: 'DIRECT_B' }]);
        f.state.sources = [snippet('source-one', 'PROJECT KNOWLEDGE; INDEXED_COPY DIRECT_B')];
        let planning = true;
        f.provider(async (endpoint, body) => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            if (planning) { planning = false; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ delegations: [
                delegation('agent-autoconfigurator', ['prompt:A']), delegation('agent-packager', ['prompt:B']), delegation('agent-indexer')] }) } }; }
            return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis(JSON.stringify(body).includes('PROJECT KNOWLEDGE') ? 'source-one' : undefined) } };
        });
        await f.run(); expect(f.calls.map(call => call.endpoint)).toEqual(['chat', 'embed', 'chat', 'chat', 'chat']);
        expect(f.row.calls_started).toBe(5); expect(f.row.result?.delegations).toHaveLength(3);
        expect(JSON.stringify(f.calls[0].body)).not.toContain('DIRECT_A'); expect(JSON.stringify(f.calls[0].body)).not.toContain('DIRECT_B');
        const a = f.calls[2].body.messages as ChatMessage[], reference = a.filter(message => message.content.includes('INDEXED_COPY'));
        expect(reference).toHaveLength(1); expect(reference[0]).toMatchObject({ role: 'user', content: expect.stringContaining('INDEXED_COPY DIRECT_B') });
        const direct = a.filter(message => !reference.includes(message)).map(message => message.content).join('\n');
        expect(direct).toContain('DIRECT_A'); expect(direct).not.toContain('DIRECT_B'); expect(direct).not.toContain('"key":"prompt:B"');
        expect(() => roleResult(JSON.stringify({ kind: 'proposal', summary: 'No', findings: [], nextSteps: [], changes: [{ targetKey: 'prompt:B', replacement: 'x', explanation: 'x' }] }),
            { ...f.prepared, targets: f.prepared.targets.filter(target => target.id === 'A') }, [])).toThrow();
        expect(f.row.result?.delegations?.every(child => child.result?.projectContext?.sources[0]?.id === 'source-one')).toBe(true);
    });
    it('without the accepted read grant no child receives an independently indexed copy of the sibling target', async () => {
        const f = await systemRoleRagPort('agent-coordinator', false, [{ kind: 'prompt', id: 'A', text: 'DIRECT_A' }, { kind: 'prompt', id: 'B', text: 'DIRECT_B' }]);
        f.state.sources = [snippet('source-one', 'PROJECT KNOWLEDGE; INDEXED_COPY DIRECT_B')]; f.flags.project_search = true;
        let planning = true;
        f.provider(async () => {
            if (planning) { planning = false; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ delegations: [
                delegation('agent-autoconfigurator', ['prompt:A']), delegation('agent-packager', ['prompt:B'])] }) } }; }
            return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis() } };
        });
        await f.run(); expect(f.calls.every(call => call.endpoint === 'chat')).toBe(true);
        const a = f.calls.find(call => call.agentId === 'agent-autoconfigurator')!;
        expect(JSON.stringify(a.body)).toContain('DIRECT_A'); expect(JSON.stringify(a.body)).not.toContain('DIRECT_B'); expect(JSON.stringify(f.calls)).not.toContain('INDEXED_COPY');
        expect(f.row.result?.delegations?.every(child => !child.result?.projectContext)).toBe(true);
    });
    it('rejects a real delegate proposal to a sibling target even when the approved index reveals its text', async () => {
        const f = await systemRoleRagPort('agent-coordinator', true, [{ kind: 'prompt', id: 'A', text: 'DIRECT_A' }, { kind: 'prompt', id: 'B', text: 'DIRECT_B' }]);
        f.state.sources = [snippet('source-one', 'PROJECT KNOWLEDGE; INDEXED_COPY DIRECT_B')]; let chats = 0;
        f.provider(async endpoint => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            const content = chats++ === 0 ? JSON.stringify({ delegations: [delegation('agent-autoconfigurator', ['prompt:A'])] })
                : chats === 2 ? JSON.stringify({ kind: 'proposal', summary: 'Change sibling', findings: [], nextSteps: [], changes: [{ targetKey: 'prompt:B', replacement: 'changed', explanation: 'from knowledge' }] }) : diagnosis();
            return { done_reason: 'stop', message: { role: 'assistant', content } };
        });
        await f.run(); expect(JSON.stringify(f.calls[2].body)).toContain('INDEXED_COPY DIRECT_B');
        expect(f.row.result?.delegations?.[0]).toMatchObject({ state: 'failed' }); expect(f.row.result?.delegations?.[0].result).toBeUndefined(); expect(f.row.result?.changes).toEqual([]);
    });
    it('reuses the same retrieval through actual MCP planning and plain finalization without raising the call budget', async () => {
        const target = { runtime: 'server' as const, assetId: 'selected', version: 1, manifest: 'a'.repeat(64), discoveryId: '00000000-0000-0000-0000-000000000003', tools: [] };
        const tool = { ...normalizeRoleMcpTool({ name: 'inspect', inputSchema: { type: 'object', properties: {} } }), toolKey: roleMcpToolKey(target, 'inspect') };
        const selected = { ...target, tools: [{ name: tool.name, schemaDigest: tool.schemaDigest }] };
        const access = { prepare: async () => [{ target: selected, tools: [tool] }], canContinueTools: async () => true, close: vi.fn(async () => undefined),
            call: vi.fn(async () => ({ id: 'receipt-one', toolKey: tool.toolKey, name: 'inspect', state: 'unknown' as const, message: 'Unconfirmed', at: '2026-10-25',
                output: { text: 'KNOWN_TOOL_RECEIPT', isError: false, truncated: false } })) };
        const f = await systemRoleRagPort('agent-ai-admin', true, [], { selection: [selected], access }); let chats = 0;
        f.provider(async endpoint => endpoint === 'embed' ? { embeddings: [[1, 2, 3]] } : { done_reason: 'stop', message: { role: 'assistant',
            content: chats++ ? diagnosis('source-one') : JSON.stringify({ kind: 'tool', toolKey: tool.toolKey, arguments: {} }) } });
        await f.run(); expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat', 'chat']); expect(f.row.calls_started).toBe(3);
        expect(access.call).toHaveBeenCalledOnce(); expect(access.close).toHaveBeenCalledOnce();
        expect(JSON.stringify(f.calls[2].body)).toContain('KNOWN_TOOL_RECEIPT'); expect(f.row.result?.projectContext?.sources).toHaveLength(1);
    });
});

describe('Optional availability, mandatory authority and paid-result retention', () => {
    it('continues after a genuine embedding network outage classified by the real Ollama owner', async () => {
        const f = await systemRoleRagPort();
        const transport = vi.fn(async () => { throw new TypeError('controlled hosting connection refused'); });
        const ollama = new OllamaClient({ fetch: transport, env: { MODEL_RUNTIME_URL: 'http://127.0.0.1:11435' } });
        f.provider(async (endpoint, body) => endpoint === 'embed' ? ollama.infer(embeddingModel, 'embed', body)
            : { done_reason: 'stop', message: { role: 'assistant', content: diagnosis() } });
        await f.run(); expect(f.row.result?.projectContext).toMatchObject({ status: 'unavailable', sources: [] });
        expect(transport).toHaveBeenCalledOnce(); expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']);
        expect(f.requests.mock.calls.some(([url]) => String(url).includes('/internal/project-rag/search'))).toBe(false);
    });
    it('does not relabel an incompatible successful embedding result as an ordinary outage', async () => {
        const f = await systemRoleRagPort(); f.provider(async () => ({ embeddings: [[1, 2]] }));
        await expect(f.run()).rejects.toMatchObject({ status: 503 }); expect(f.calls.map(call => call.endpoint)).toEqual(['embed']); expect(f.row.result).toBeNull();
    });
    it('distinguishes no matching project evidence from an unavailable search', async () => {
        const f = await systemRoleRagPort(); f.state.sources = []; await f.run();
        expect(f.row.result?.projectContext).toMatchObject({ status: 'empty', sources: [] }); expect(f.row.result?.findings).toEqual([]);
    });
    it.each([502, 503, 504])('keeps an ordinary answer on real retrieval HTTP %i without retrying', async status => {
        const f = await systemRoleRagPort(); f.state.response = () => new Response('proxy page', { status }); await f.run();
        expect(f.row.result?.projectContext).toMatchObject({ status: 'unavailable', sources: [] }); expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']);
        expect(f.requests.mock.calls.filter(([url]) => String(url).includes('/internal/project-rag/search'))).toHaveLength(1);
    });
    it.each([200, 401, 403])('does not hide malformed/auth retrieval HTTP %i as optional availability', async status => {
        const f = await systemRoleRagPort(); f.state.response = () => new Response(status === 200 ? '{' : JSON.stringify({ message: 'denied' }), { status });
        await expect(f.run()).rejects.toBeInstanceOf(Error); expect(f.calls.map(call => call.endpoint)).toEqual(['embed']); expect(f.row.result).toBeNull();
    });
    it('keeps missing-index metadata honest and does not reserve an embedding call', async () => {
        const f = await systemRoleRagPort(); f.selected.activeSnapshot = null;
        await f.accept(await f.owner.prepare(f.req, 'agent-ai-admin', f.row.snapshot.selection)); await f.run();
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat']); expect(f.row.result?.projectContext).toMatchObject({ status: 'unavailable', sources: [] });
    });
    it('retains a completed paid answer and its source receipt if search turns OFF during the provider call', async () => {
        const f = await systemRoleRagPort(); f.provider(async endpoint => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            f.flags.project_search = false; return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis('source-one') } };
        });
        await f.run(); expect(f.row.state).toBe('succeeded'); expect(f.row.result?.projectContext?.sources).toHaveLength(1);
    });
    it('rechecks search admission after a real runtime identity read waits, before starting the answer provider', async () => {
        const f = await systemRoleRagPort(); let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        const infer = f.runtime.infer.bind(f.runtime);
        vi.spyOn(f.runtime, 'infer').mockImplementation((...args) => {
            if (args[1] === 'chat') vi.mocked(ProjectEmbeddingRepository.prototype.read).mockImplementationOnce(async () => { entered(); await held; return f.selected; });
            return infer(...args);
        });
        const work = f.run().catch(error => error);
        try { await waiting; f.flags.project_search = false; release(); expect(await work).toMatchObject({ status: 403 }); }
        finally { release(); await work; }
        expect(f.calls.map(call => call.endpoint)).toEqual(['embed']); expect(f.row.result).toBeNull();
    });
    it('retains a completed child receipt when search OFF prevents every subsequent child or summary dispatch', async () => {
        const f = await systemRoleRagPort('agent-coordinator'); let planning = true;
        f.provider(async endpoint => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            if (planning) { planning = false; return { done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ delegations: roles.slice(0, 3).map(id => delegation(id)) }) } }; }
            f.flags.project_search = false; return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis('source-one') } };
        });
        await f.run(); expect(f.calls.map(call => call.endpoint)).toEqual(['chat', 'embed', 'chat']);
        expect(f.row.result?.delegations?.map(child => child.state)).toEqual(['succeeded', 'failed', 'failed']);
        expect(f.row.result?.delegations?.[0].result?.projectContext?.sources).toHaveLength(1);
    });
    it('blocks a pending sync instead of treating incomplete ownership as an optional outage', async () => {
        const f = await systemRoleRagPort(); f.state.pending = true;
        await expect(f.run()).rejects.toMatchObject({ status: 409 }); expect(f.calls).toEqual([]);
    });
    it.each(['acl', 'pin', 'snapshot', 'lease', 'abort'] as const)('discards a late paid answer on %s change without replay', async change => {
        const f = await systemRoleRagPort(); f.provider(async endpoint => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            if (change === 'acl') f.state.allowed = false;
            if (change === 'pin') f.state.pin = false;
            if (change === 'snapshot') f.selected.activeSnapshot = 'c'.repeat(64);
            if (change === 'lease') f.row.state = 'cancelled';
            if (change === 'abort') f.abort.abort(new Error('cancelled'));
            return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis('source-one') } };
        });
        await expect(f.run()).rejects.toBeInstanceOf(Error); expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']); expect(f.row.result).toBeNull();
    });
    it('does not buy a third call repairing malformed JSON after an embedding consumed the shared budget', async () => {
        const f = await systemRoleRagPort(); f.provider(async endpoint => endpoint === 'embed' ? { embeddings: [[1, 2, 3]] } : { done_reason: 'stop', message: { role: 'assistant', content: '{}' } });
        await expect(f.run()).rejects.toThrow(); expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']); expect(f.row.calls_started).toBe(2);
    });
    it('projects known private excerpt forms before delivery and excludes arbitrary raw fields from receipts', async () => {
        const f = await systemRoleRagPort(); f.state.sources = [snippet('source-one', 'PROJECT KNOWLEDGE\nAPI_KEY=do-not-send')];
        await f.run(); expect(JSON.stringify(f.calls)).not.toContain('do-not-send'); expect(JSON.stringify(f.row.result)).not.toContain('do-not-send');
    });
    it.each(['acl', 'pin', 'snapshot', 'off'] as const)('revalidates %s after the actual final repository lock waits, retaining only flag-OFF paid answers', async change => {
        const f = await systemRoleRagPort(); let paid = false, afterPaidLocks = 0, entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
        const client = { release: vi.fn(), query: vi.fn(async (sql: string) => {
            if (sql.startsWith('SELECT * FROM system_role_runs')) {
                // Standalone answer: provider checkpoint, completion checkpoint, then the accepting lock.
                if (paid && ++afterPaidLocks === 3) { entered(); await held; }
                return { rows: f.row.state === 'running' ? [f.row] : [], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }) };
        const repository = new SystemRoleRepository({ connect: async () => client } as unknown as Pool);
        f.repository.fenced = (id, lease, work) => repository.fenced(id, lease, (db, row) => work(db, row));
        f.provider(async (endpoint, body) => {
            if (endpoint === 'embed') return { embeddings: [[1, 2, 3]] };
            paid = true; return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis(JSON.stringify(body).includes('PROJECT KNOWLEDGE') ? 'source-one' : undefined) } };
        });
        const work = f.run().then(() => undefined, error => error);
        try {
            await waiting;
            if (change === 'acl') f.state.allowed = false;
            if (change === 'pin') f.state.pin = false;
            if (change === 'snapshot') f.selected.activeSnapshot = 'c'.repeat(64);
            if (change === 'off') f.flags.project_search = false;
            release();
            if (change === 'off') { expect(await work).toBeUndefined(); expect(f.row.result?.projectContext?.sources).toHaveLength(1); }
            else { expect(await work).toBeInstanceOf(Error); expect(f.row.result).toBeNull(); }
        } finally { release(); await work; }
        expect(f.calls.map(call => call.endpoint)).toEqual(['embed', 'chat']);
        expect(client.release).toHaveBeenCalled();
        if (change === 'snapshot' || change === 'off') {
            expect(client.query.mock.calls.some(([sql]) => sql === 'SELECT id FROM projects WHERE id=$1 FOR SHARE')).toBe(true);
            expect(vi.mocked(ProjectEmbeddingRepository.prototype.read).mock.calls.map(call => call[1])).toContain(client);
        }
    });
});
