import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { readStoredBuildDraft, saveStoredBuildDraft } from '../buildDraftStore';
import type { IToolBuildRequest } from '../../interfaces';

afterEach(() => vi.unstubAllGlobals());
it('retains the recovered recipe revision, platforms and tags in the durable request', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const request: IToolBuildRequest = {
        requestKey: '11111111-1111-4111-8111-111111111111',
        kind: 'mcp',
        name: 'Original',
        description: 'Original description',
        source: { type: 'bundled', id: 'mcp-recipe', revision: 'a'.repeat(64) },
        targets: ['linux-x64-glibc'],
        tags: ['original'],
    };
    await saveStoredBuildDraft('owner:bundled-catalog', request);
    const restored = await readStoredBuildDraft('owner:bundled-catalog');
    expect(restored?.request).toEqual(request);
});
