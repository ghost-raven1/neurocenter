import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {IOperationDetail} from '../src/core/api/interfaces';
import type {ServiceTurn} from '../src/features/SystemRoleChat/types';
import {readTabSnapshot} from '../src/features/TabNotifications/read';
import {projectTabSnapshot} from '../src/features/TabNotifications/snapshots';
import {createTabNotificationTracker} from '../src/features/TabNotifications/tracker';
import api from '../src/core/api/base';
import {modelChatApi} from '../src/features/ModelChat/api';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {systemRoleChatsApi} from '../src/features/SystemRoleChat/api';
import {detail, turn} from './model-chat-fixtures';
import {projectMessage, projectRoom} from './project-chat-fixtures';
import {tabModel, tabRoom, tabService} from './tab-notification-fixtures';

vi.mock('../src/core/api/base', () => ({default: {get: vi.fn()}}));
vi.mock('../src/features/ModelChat/api', () => ({modelChatApi: {read: vi.fn()}}));
vi.mock('../src/features/ProjectChat/api', () => ({projectChatApi: {read: vi.fn()}}));
vi.mock('../src/features/SystemRoleChat/api', () => ({systemRoleChatsApi: {read: vi.fn(), request: vi.fn()}}));
beforeEach(() => {vi.clearAllMocks();});

describe('Notification GET contracts do not mark messages viewed or invoke models', () => {
    it('reads the exact known personal dialogue with the monitor AbortSignal', async () => {
        const controller = new AbortController(), value = detail();
        vi.mocked(modelChatApi.read).mockResolvedValue({...value, conversation: {...value.conversation, id: tabModel.id}, turns: [turn({status: 'pending'})]});
        const result = await readTabSnapshot(tabModel, controller.signal);
        expect(modelChatApi.read).toHaveBeenCalledExactlyOnceWith(tabModel.id, controller.signal); expect(result.rows[0].state).toBe('pending');
    });
    it('keeps the exact TEAM project, private room and older pending IDs in the authorized GET', async () => {
        const controller = new AbortController(), value = projectRoom();
        vi.mocked(projectChatApi.read).mockResolvedValue({...value, room: {...value.room, id: tabRoom.id}});
        await readTabSnapshot(tabRoom, controller.signal, ['older-slot']);
        expect(projectChatApi.read).toHaveBeenCalledExactlyOnceWith('prj-one', controller.signal, ['older-slot'], tabRoom.id);
    });
    it('settles an older watched TEAM slot returned beside 50 newer messages instead of keeping it pending forever', async () => {
        const tracker = createTabNotificationTracker(); tracker.configure('alice', 'alice@example.test', true); tracker.setHidden(true);
        const value = projectRoom(), older = projectMessage({id: 'older-slot', roomId: tabRoom.id, position: '1', kind: 'agent', author: null, status: 'running'});
        const newer = Array.from({length: 50}, (_, index) => projectMessage({id: `newer-${index}`, roomId: tabRoom.id, position: String(index + 2)}));
        const baseline = {...value, room: {...value.room, id: tabRoom.id}, messages: [older, ...newer]};
        tracker.accept('alice', projectTabSnapshot(baseline)); expect(tracker.pendingIds('alice', tabRoom)).toEqual(['older-slot']); expect(tracker.count()).toBe(0);
        vi.mocked(projectChatApi.read).mockResolvedValue({...baseline, room: {...baseline.room, revision: 2}, messages: [{...older, status: 'done'}, ...newer]});
        tracker.accept('alice', await readTabSnapshot(tabRoom, new AbortController().signal, tracker.pendingIds('alice', tabRoom)));
        expect(tracker.pendingIds('alice', tabRoom)).toEqual([]); expect(tracker.count()).toBe(1);
    });
    it('does not accept a model response belonging to another project as this watch', async () => {
        const value = detail(); vi.mocked(modelChatApi.read).mockResolvedValue({...value, conversation: {...value.conversation, id: tabModel.id, projectId: 'prj-other'}});
        await expect(readTabSnapshot(tabModel, new AbortController().signal)).rejects.toMatchObject({response: {status: 403}});
    });
    it('an unknown server state is not reclassified as a completed model call', async () => {
        const value = detail();
        const unconfirmed = {...turn(), status: 'unknown'} as unknown as ReturnType<typeof turn>;
        vi.mocked(modelChatApi.read).mockResolvedValue({...value, conversation: {...value.conversation, id: tabModel.id}, turns: [unconfirmed]});
        expect((await readTabSnapshot(tabModel, new AbortController().signal)).rows[0].state).toBe('pending');
    });
    it('recovers one exact service request even outside its 100-turn history page', async () => {
        const controller = new AbortController(), row: ServiceTurn = {id: 'known-request', agentId: 'agent-coordinator', instruction: '', createdAt: '2026-10-25T00:00:00Z', cancelRequested: false, run: null};
        vi.mocked(systemRoleChatsApi.request).mockResolvedValue(row);
        const result = await readTabSnapshot(tabService, controller.signal, ['known-request']);
        expect(systemRoleChatsApi.request).toHaveBeenCalledExactlyOnceWith(tabService.id, 'known-request', controller.signal);
        expect(systemRoleChatsApi.read).not.toHaveBeenCalled(); expect(result.rows).toEqual([{id: row.id, order: row.createdAt, state: 'pending', version: undefined}]);
    });
    it('rejects an unrelated service request receipt', async () => {
        vi.mocked(systemRoleChatsApi.request).mockResolvedValue({id: 'another-request'} as ServiceTurn);
        await expect(readTabSnapshot(tabService, new AbortController().signal, ['known-request'])).rejects.toMatchObject({response: {status: 403}});
    });
    it('reads a specific operation ID rather than inferring completion from the active summary', async () => {
        const controller = new AbortController(), source = {kind: 'operation' as const, id: 'op/one', projectId: 'prj-one'};
        const operation: IOperationDetail = {operationId: source.id, projectId: source.projectId, type: 'SYNC', resourceType: 'rag', resourceId: 'index', actor: 'alice@example.test', state: 'SUCCEEDED', percent: 100,
            bytesDone: 0, bytesTotal: 0, startedAt: '2026-10-25T00:00:00Z', finishedAt: '2026-10-25T00:01:00Z', error: null, log: [], retries: 0};
        vi.mocked(api.get).mockResolvedValue({data: operation});
        const result = await readTabSnapshot(source, controller.signal);
        expect(api.get).toHaveBeenCalledExactlyOnceWith('/api/operations/op%2Fone', {signal: controller.signal}); expect(result.rows[0].state).toBe('terminal');
    });
});
