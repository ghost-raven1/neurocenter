import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import { ModelChatService } from '../src/model-chat/chat.service';
import type { ModelsService } from '../src/models/models.service';
import type { ModelRuntime } from '../src/models/model-runtime';
import type { ConversationRow } from '../src/model-chat/chat.types';
const services: ModelChatService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.pool.end(); });
function fixture() {
    const actor = { email: 'owner@localhost', activeRole: 'Разработчик', claims: { projects: [{ projectId: 'prj-a', role: 'Разработчик' }] } };
    const models = { actor: vi.fn(async () => structuredClone(actor)), resolveProject: vi.fn(async () => ({ id: 'prj-a' })), getUsable: vi.fn(async () => ({})) };
    const service = new ModelChatService(models as unknown as ModelsService, {} as ModelRuntime); services.push(service);
    const row = (id: string, modelId = id): ConversationRow => ({ id, model_id: modelId, owner_email: actor.email, project_id: 'prj-a', title: id, model_pin: 'a'.repeat(64), revision: 1, mode: 'model', agent_ids: [], created_at: new Date(), updated_at: new Date() });
    const list = vi.spyOn(service.repository, 'list').mockResolvedValue([row('model-a'), row('model-b'), row('model-c')]);
    return { service, models, actor, list, row, req: { headers: {} } as Request };
}
describe('Cross-model personal conversation enumeration', () => {
    it('filters only revoked or missing models while passing exact canonical project and owner to SQL', async () => {
        const f = fixture(); f.models.getUsable.mockImplementation(async id => { if (id === 'model-b') throw new ForbiddenException(); if (id === 'model-c') throw new NotFoundException(); return {}; });
        const result = await f.service.list(f.req, undefined, 'Project alias'); expect(result.items.map(item => item.id)).toEqual(['model-a']);
        expect(f.list).toHaveBeenCalledExactlyOnceWith(f.actor.email, undefined, 'prj-a'); expect(f.models.getUsable.mock.calls.map(call => call[0])).toEqual(['model-a', 'model-b', 'model-c']);
    });
    it('does not hide infrastructure failures behind an incomplete successful list', async () => {
        const f = fixture(); f.models.getUsable.mockRejectedValueOnce(new ServiceUnavailableException('temporary failure'));
        await expect(f.service.list(f.req)).rejects.toThrow('temporary failure');
    });
    it('withdraws the entire response when ownership or current project grants change during listing', async () => {
        const f = fixture(); f.models.actor.mockResolvedValueOnce(structuredClone(f.actor)).mockResolvedValue({ ...f.actor, claims: { projects: [] } });
        await expect(f.service.list(f.req, undefined, 'prj-a')).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('never lets an observer enumerate an empty aggregate even without a model filter', async () => {
        const f = fixture(); f.models.actor.mockResolvedValue({ ...f.actor, activeRole: 'Наблюдатель' });
        await expect(f.service.list(f.req)).rejects.toBeInstanceOf(ForbiddenException); expect(f.list).not.toHaveBeenCalled();
    });
    it('omitted project is only the personal common scope, not every project', async () => {
        const f = fixture(); f.list.mockResolvedValue([]); await f.service.list(f.req);
        expect(f.list).toHaveBeenCalledExactlyOnceWith(f.actor.email, undefined, null); expect(f.models.resolveProject).not.toHaveBeenCalled();
    });
});
