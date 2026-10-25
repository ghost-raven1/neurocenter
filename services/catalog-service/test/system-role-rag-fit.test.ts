import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemRoleRagContext } from '../src/system-roles/system-role.rag-context';
import { roleResult } from '../src/system-roles/system-role.validation';
import { diagnosis, snippet, systemRoleRagPort } from './helpers/system-role-rag-port';
import type { ChatMessage } from '../src/model-chat/chat.types';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const question: ChatMessage[] = [{ role: 'user', content: 'The exact original question.' }];
async function fixture() {
    const f = await systemRoleRagPort();
    const rag = new SystemRoleRagContext(f.context, f.req, f.row, f.abort.signal, async () => f.row.model, f.runtime.infer.bind(f.runtime));
    return { ...f, rag };
}

describe('Recipient-scoped project evidence, not synthetic path permissions', () => {
    it('does not disclose indexed copies to an unapproved recipient or buy another retrieval for it', async () => {
        const f = await fixture(); f.state.sources = [snippet('source-one', 'INDEXED_COPY_OF_B')];
        const a = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 16000 });
        const b = await f.rag.fit('agent-autoconfigurator', question, { contextWindowTokens: 16000 });
        expect(JSON.stringify(a.messages)).toContain('INDEXED_COPY_OF_B'); expect(a.projectContext?.sources).toHaveLength(1);
        expect(b).toEqual({ messages: question }); expect(f.calls.map(call => call.endpoint)).toEqual(['embed']);
        expect(f.requests.mock.calls.filter(([url]) => String(url).includes('/internal/project-rag/search'))).toHaveLength(1);
    });
    it('fits each recipient prompt independently, validates only delivered citations and leaves shared sources and the question intact', async () => {
        const f = await fixture(); f.state.sources = Array.from({ length: 6 }, (_, index) => ({ ...snippet('source-' + index, '界'.repeat(900)), startLine: 1 + index * 100, endLine: 7 + index * 100 }));
        const large = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 16000 });
        const small = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 1800, reservedOutputTokens: 128 });
        const again = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 16000 });
        expect(large.projectContext?.sources).toHaveLength(6); expect(small.projectContext!.sources.length).toBeLessThan(6);
        expect(again).toEqual(large); expect(small.messages.at(-1)).toEqual(question[0]);
        expect(() => roleResult(diagnosis('source-5'), f.prepared, [], small.projectContext)).toThrow('JSON-контракта');
        expect(roleResult(diagnosis('source-5'), f.prepared, [], large.projectContext).findings[0].evidenceId).toBe('source-5');
        expect(f.calls.map(call => call.endpoint)).toEqual(['embed']);
    });
    it('keeps optional context under the role byte ceiling and never truncates mandatory text', async () => {
        const f = await fixture(); f.state.sources = Array.from({ length: 6 }, (_, index) => snippet('source-' + index, 'x'.repeat(3000)));
        const mandatory: ChatMessage[] = [{ role: 'user', content: 'q'.repeat(64000) }];
        const fit = await f.rag.fit('agent-ai-admin', mandatory, { contextWindowTokens: 131072 });
        expect(fit.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.content), 0)).toBeLessThanOrEqual(65536);
        expect(fit.projectContext).toBeDefined();
        expect(fit.messages.at(-1)?.content).toBe(mandatory[0].content); expect(fit.projectContext!.sources.length).toBeLessThan(6);
        expect(JSON.stringify(fit.projectContext)).not.toContain('x'.repeat(3000));
    });
    it('omits a source before delivery when its safe metadata cannot fit the bounded durable receipt', async () => {
        const f = await fixture(); f.state.sources = [snippet('a'.repeat(1024)), { ...snippet('b'.repeat(1024)), path: 'p'.repeat(1024) }];
        const fit = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 16000 });
        expect(fit.projectContext).toBeDefined();
        expect(Buffer.byteLength(JSON.stringify(fit.projectContext))).toBeLessThanOrEqual(2048);
        expect(fit.projectContext?.sources.map(source => source.id)).not.toContain('b'.repeat(1024));
        expect(JSON.stringify(fit.messages)).not.toContain('b'.repeat(1024));
    });
    it('keeps raw extra fields and known credential forms out of model messages and safe source receipts', async () => {
        const f = await fixture(); f.state.response = () => Response.json({ generation: f.selected.activeGeneration, snapshot: f.selected.activeSnapshot,
            sources: [{ ...snippet(), excerpt: 'REFERENCE\nAuthorization: Bearer do-not-transmit', rawVector: [1, 2, 3], credential: 'raw-extra-secret' }] });
        const fit = await f.rag.fit('agent-ai-admin', question, { contextWindowTokens: 16000 });
        expect(JSON.stringify(fit)).not.toContain('do-not-transmit'); expect(JSON.stringify(fit)).not.toContain('raw-extra-secret'); expect(JSON.stringify(fit)).not.toContain('rawVector');
        expect(fit.messages[0].role).toBe('user'); expect(fit.messages.at(-1)).toEqual(question[0]);
        expect(fit.projectContext?.sources).toEqual([{ id: 'source-one', path: 'docs/unrelated-name.md', startLine: 3, endLine: 7 }]);
    });
});
