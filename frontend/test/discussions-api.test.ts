import {beforeEach, describe, expect, it, vi} from 'vitest';
import base from '../src/core/api/base';
import {discussionsApi} from '../src/features/Discussions/api';
vi.mock('../src/core/api/base', () => ({default: {get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn()}}));
beforeEach(() => {vi.resetAllMocks(); for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) vi.mocked(base[method]).mockResolvedValue({data: {ok: true}});});
describe('Discussion transport contract', () => {
    it('Uses query target identity for reactions including skill IDs with slashes', async () => {
        const targetId = 'skill:common/code-review'; await discussionsApi.reaction(targetId); await discussionsApi.setReaction(targetId, true); await discussionsApi.setReaction(targetId, false);
        expect(base.get).toHaveBeenCalledWith('/api/catalog-reactions', {params: {targetId}, timeout: 20000}); expect(base.put).toHaveBeenCalledWith('/api/catalog-reactions', undefined, {params: {targetId}, timeout: 20000}); expect(base.delete).toHaveBeenCalledWith('/api/catalog-reactions', {params: {targetId}, timeout: 20000});
    });
    it('Sends raw file bytes and explicit encoded name/UUID without multipart serialization', async () => {
        const target = {type: 'catalog' as const, id: 'plugin:one'}, file = new File(['owned bytes'], 'журнал №1.txt'), key = '302f081a-906d-4e78-8f30-130b8fda5260';
        await discussionsApi.upload(target, file, key, () => undefined); const call = vi.mocked(base.post).mock.calls[0];
        expect(call[0]).toBe('/api/discussions/attachments'); expect(call[1]).toBe(file); expect(call[2]).toEqual(expect.objectContaining({params: {targetType: 'catalog', targetId: 'plugin:one'}, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Request-Key': key}}));
    });
    it('Pagination, replies and CAS editing/deletion carry exact target and version fields', async () => {
        const target = {type: 'help' as const, id: 'bridge'}, intent = {body: 'Ответ', parentId: 'parent', attachmentIds: ['file'], requestKey: 'same-uuid'};
        await discussionsApi.list(target, 'cursor'); await discussionsApi.create(target, intent); await discussionsApi.edit('one', 'Новый текст', 3); await discussionsApi.remove('one', 4);
        expect(base.get).toHaveBeenCalledWith('/api/discussions', {params: {targetType: 'help', targetId: 'bridge', cursor: 'cursor'}, timeout: 20000}); expect(base.post).toHaveBeenCalledWith('/api/discussions/comments', {targetType: 'help', targetId: 'bridge', ...intent}, {timeout: 20000}); expect(base.patch).toHaveBeenCalledWith('/api/discussions/comments/one', {body: 'Новый текст', expectedVersion: 3}, {timeout: 20000}); expect(base.delete).toHaveBeenCalledWith('/api/discussions/comments/one', {params: {expectedVersion: 4}, timeout: 20000});
    });
});
