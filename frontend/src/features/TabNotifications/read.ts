import api from '../../core/api/base';
import type {IOperationDetail} from '../../core/api/interfaces';
import {modelChatApi} from '../ModelChat/api';
import {projectChatApi} from '../ProjectChat/api';
import {systemRoleChatsApi} from '../SystemRoleChat/api';
import {modelTabSnapshot, operationTabSnapshot, projectTabSnapshot, serviceTabSnapshot} from './snapshots';
import {tabSourceKey, type TabSnapshot, type TabSource} from './types';

/** Only exact authorized GETs are used; this path never marks messages viewed or starts work. */
export async function readTabSnapshot(source: TabSource, signal: AbortSignal, watchIds: string[] = []): Promise<TabSnapshot> {
    let value: TabSnapshot | undefined;
    switch (source.kind) {
        case 'model': value = modelTabSnapshot(await modelChatApi.read(source.id, signal)); break;
        case 'project': value = projectTabSnapshot(await projectChatApi.read(source.projectId, signal, watchIds.length ? watchIds : undefined, source.id), watchIds); break;
        case 'service': {
            if (watchIds.length) {
                try {
                    const turn = await systemRoleChatsApi.request(source.id, watchIds[0], signal);
                    if (turn.id !== watchIds[0]) throw {response: {status: 403}};
                    value = serviceTabSnapshot({dialog: {id: source.id, projectId: source.projectId, title: '', createdAt: '', updatedAt: ''}, turns: [turn]});
                } catch (cause) {
                    if ((cause as {response?: {status?: number}})?.response?.status !== 404) throw cause;
                    // The POST may still commit. Only the dialog read can confirm loss of its current access.
                    value = serviceTabSnapshot(await systemRoleChatsApi.read(source.id, signal));
                }
            } else value = serviceTabSnapshot(await systemRoleChatsApi.read(source.id, signal));
            break;
        }
        case 'operation': value = operationTabSnapshot(await api.get<IOperationDetail>('/api/operations/' + encodeURIComponent(source.id), {signal}).then(result => result.data)); break;
    }
    if (!value || tabSourceKey(source) !== tabSourceKey(value.source)) throw {response: {status: 403}};
    return value;
}
