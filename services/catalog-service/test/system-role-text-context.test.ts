import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosis, delegation, snippet, systemRoleRagPort } from './helpers/system-role-rag-port';
import type { TextContext } from '../../shared/project-text-knowledge.cjs';
import type { SystemRoleId } from '../src/system-roles/system-role.types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** Real role consent, runner, context fitting and model admission; only the durable/RAG/provider ports are controlled. */
async function textRole(id: SystemRoleId = 'agent-ai-admin') {
    const f = await systemRoleRagPort(id, false);
    const selector: TextContext = { mode: 'text', revision: 1, corpusHash: 'f'.repeat(64), query: 'project knowledge' };
    const corpus = { mode: 'text' as const, projectId: f.project.id, revision: selector.revision, corpusHash: selector.corpusHash,
        documentCount: 1, bytes: 128, updatedAt: null };
    const rpc = vi.spyOn(f.context.text.client, 'call').mockImplementation(async (route: string) => {
        if (route.endsWith('/state')) return { ...corpus };
        if (route.endsWith('/search')) return { ...corpus, sources: [snippet()] };
        throw new Error('Unexpected text RAG fixture call');
    });
    // Fresh project text knowledge has no selected embedding model, active generation or local model.
    Object.assign(f.selected, { model: null, profile: null, activeGeneration: null, activeSnapshot: null });
    const prepared = await f.owner.prepare(f.req, id, { ...f.prepared.selection, textContext: selector });
    await f.accept(prepared); f.row.request.textContext = selector;
    return { ...f, selector, corpus, rpc, accepted: prepared };
}

describe('Explicit base text knowledge in real system-role execution', () => {
    it('pins free consent and sends cited text with one ordinary chat call and zero embeddings', async () => {
        const f = await textRole();
        expect(f.calls).toEqual([]);
        expect(f.accepted.projectContext).toMatchObject({ scope: 'project-text', textContext: f.selector });
        await f.run();
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat']);
        expect(f.calls[0].requiredFeatures).toContain('project_text_knowledge');
        expect(f.calls[0].requiredFeatures).not.toContain('project_search');
        expect(JSON.stringify(f.calls[0].body)).toContain('PROJECT KNOWLEDGE');
        expect(f.row.result).toMatchObject({ findings: [{ evidenceId: 'source-one' }], projectContext: {
            mode: 'text', textRevision: 1, corpusHash: f.selector.corpusHash, status: 'ready', sources: [{ id: 'source-one', startLine: 3 }] } });
        expect(JSON.stringify(f.row.result)).not.toContain('PROJECT KNOWLEDGE');
        expect(f.rpc.mock.calls.filter(([route]) => route.endsWith('/search'))).toHaveLength(1);
    });

    it.each(['revision', 'hash', 'acl', 'flag', 'abort'] as const)('rejects %s changes before a provider call while preserving accepted consent', async change => {
        const f = await textRole(), accepted = structuredClone(f.row.snapshot);
        if (change === 'revision') f.corpus.revision++;
        if (change === 'hash') f.corpus.corpusHash = 'e'.repeat(64);
        if (change === 'acl') f.state.allowed = false;
        if (change === 'flag') f.flags.project_text_knowledge = false;
        if (change === 'abort') f.abort.abort(new Error('Stopped'));
        await expect(f.run()).rejects.toBeInstanceOf(Error);
        expect(f.calls).toEqual([]); expect(f.row.result).toBeNull(); expect(f.row.snapshot).toEqual(accepted);
    });

    it('shares a single approved word search across coordinator delegates and summary', async () => {
        const f = await textRole('agent-coordinator'); let planning = true;
        f.provider(async (endpoint, body) => {
            if (endpoint !== 'chat') throw new Error('Text knowledge must not request embeddings');
            const content = planning ? JSON.stringify({ delegations: [delegation('agent-indexer'), delegation('agent-ai-admin')] })
                : diagnosis(JSON.stringify(body).includes('PROJECT KNOWLEDGE') ? 'source-one' : undefined);
            planning = false; return { done_reason: 'stop', message: { role: 'assistant', content } };
        });
        await f.run();
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat', 'chat', 'chat', 'chat']);
        expect(f.rpc.mock.calls.filter(([route]) => route.endsWith('/search'))).toHaveLength(1);
        expect(f.row.result?.delegations?.every(child => child.result?.projectContext?.mode === 'text')).toBe(true);
        expect(f.row.result?.projectContext).toMatchObject({ mode: 'text', textRevision: 1, corpusHash: f.selector.corpusHash });
    });

    it('retains a completed paid answer and source receipt if only text admission turns OFF in flight', async () => {
        const f = await textRole();
        f.provider(async () => { f.flags.project_text_knowledge = false; return { done_reason: 'stop', message: { role: 'assistant', content: diagnosis('source-one') } }; });
        await f.run();
        expect(f.calls.map(call => call.endpoint)).toEqual(['chat']); expect(f.row.state).toBe('succeeded');
        expect(f.row.result?.projectContext).toMatchObject({ mode: 'text', sources: [{ id: 'source-one' }] });
    });
});
