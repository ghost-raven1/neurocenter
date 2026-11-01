import api from '../../core/api/base';
import type { IRoleSelection, IRoleStart, TSystemRoleId } from '../SystemRoles/interfaces';
import type { IServiceDetail, IServiceDialog, IServicePreview, IServiceTurn } from './interfaces';

const base = '/api/system-role-chats',
    path = (id: string): string => base + '/' + encodeURIComponent(id);
/** Reading history or an accepted request never starts another model operation. */
export const systemRoleChatsApi = {
    list: (projectId?: string): Promise<IServiceDialog[]> =>
        api.get<IServiceDialog[]>(base, { params: { projectId } }).then((value) => value.data),
    create: (input: {
        id: string;
        title: string;
        projectId: string | null;
        agentId: TSystemRoleId;
    }): Promise<IServiceDialog> => api.post<IServiceDialog>(base, input).then((value) => value.data),
    read: (id: string, signal?: AbortSignal): Promise<IServiceDetail> =>
        (signal ? api.get<IServiceDetail>(path(id), { signal }) : api.get<IServiceDetail>(path(id))).then(
            (value) => value.data,
        ),
    prepare: (
        id: string,
        agentId: TSystemRoleId,
        selection: IRoleSelection,
        includeContext: boolean,
    ): Promise<IServicePreview> =>
        api
            .post<IServicePreview>(path(id) + '/prepare', { agentId, selection, includeContext })
            .then((value) => value.data),
    start: (id: string, agentId: TSystemRoleId, input: IRoleStart): Promise<IServiceTurn> =>
        api.post<IServiceTurn>(path(id) + '/turns', { agentId, input }).then((value) => value.data),
    request: (id: string, requestId: string, signal?: AbortSignal): Promise<IServiceTurn> =>
        (signal
            ? api.get<IServiceTurn>(path(id) + '/requests/' + encodeURIComponent(requestId), { signal })
            : api.get<IServiceTurn>(path(id) + '/requests/' + encodeURIComponent(requestId))
        ).then((value) => value.data),
    cancel: (id: string, turn: IServiceTurn, requestId: string): Promise<IServiceTurn> =>
        api
            .post<IServiceTurn>(path(id) + '/turns/' + encodeURIComponent(turn.id) + '/cancel', {
                requestId,
                expectedRevision: turn.run!.revision,
            })
            .then((value) => value.data),
};

/** A role projection retains original dialog/turn IDs and uses the existing receipt actions. */
export function roleConversationApi(agentId: TSystemRoleId): typeof systemRoleChatsApi {
    return {
        ...systemRoleChatsApi,
        list: (projectId) =>
            api.get<IServiceDialog[]>(base, { params: { projectId, agentId } }).then((value) => value.data),
        read: (id, signal) =>
            api
                .get<IServiceDetail>(path(id), { params: { agentId }, ...(signal ? { signal } : {}) })
                .then((value) => value.data),
        create: (input) => systemRoleChatsApi.create({ ...input, agentId }),
    };
}
