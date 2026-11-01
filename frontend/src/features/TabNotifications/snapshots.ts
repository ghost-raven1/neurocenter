import type { IOperation } from '../../core/api/interfaces';
import type { IModelChatDetail } from '../ModelChat/interfaces';
import type { IProjectChatDetail } from '../ProjectChat/interfaces';
import { DEFAULT_PROJECT_CHAT_ROOM } from '../ProjectChat/constants';
import type { IServiceDetail } from '../SystemRoleChat/interfaces';
import type { IRoleRun } from '../SystemRoles/interfaces';
import type { ITabRow, ITabSnapshot, TTabSource } from './interfaces';

export const modelTabSource = (id: string, projectId?: string | null): TTabSource => ({
    kind: 'model',
    id,
    projectId: projectId ?? null,
});
export const serviceTabSource = (id: string, projectId?: string | null): TTabSource => ({
    kind: 'service',
    id,
    projectId: projectId ?? null,
});
export const projectTabSource = (projectId: string, roomId = DEFAULT_PROJECT_CHAT_ROOM): TTabSource => ({
    kind: 'project',
    id: roomId,
    projectId,
});

/** Mirror the existing server page windows; older loaded history cannot become a new-message notification. */
export function modelTabSnapshot(value: IModelChatDetail): ITabSnapshot {
    return {
        source: modelTabSource(value.conversation.id, value.conversation.projectId),
        revision: value.conversation.revision,
        rows: value.turns.slice(-50).map((turn) => ({
            id: turn.requestId,
            order: turn.createdAt,
            stamp: turn.status,
            state: ['done', 'failed', 'cancelled'].includes(turn.status) ? 'terminal' : 'pending',
        })),
    };
}
/** Exact watched rows remain visible after completion, even outside the latest server page. */
export function projectTabSnapshot(value: IProjectChatDetail, watchedIds: readonly string[] = []): ITabSnapshot {
    const watched = new Set(watchedIds),
        recent = value.messages.slice(-50),
        pending = value.messages.filter((row) => ['queued', 'running'].includes(row.status) || watched.has(row.id));
    const messages = [...new Map([...recent, ...pending].map((row) => [row.id, row])).values()];
    return {
        source: projectTabSource(value.room.projectId, value.room.id),
        revision: value.room.revision,
        rows: messages.map((row) => ({
            id: row.id,
            order: row.position,
            stamp: row.status,
            actor: row.kind === 'user' ? row.author?.email : undefined,
            state: ['done', 'failed', 'cancelled'].includes(row.status) ? 'terminal' : 'pending',
        })),
    };
}
export function serviceTabSnapshot(value: IServiceDetail): ITabSnapshot {
    return {
        source: serviceTabSource(value.dialog.id, value.dialog.projectId),
        rows: value.turns.slice(-100).map((turn) => {
            const state: ITabRow['state'] =
                turn.run?.state === 'awaiting_review'
                    ? 'attention'
                    : turn.run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(turn.run.state)
                      ? 'terminal'
                      : 'pending';
            return { id: turn.id, order: turn.createdAt, state, version: turn.run?.revision, stamp: turn.run?.state };
        }),
    };
}
export function operationTabSnapshot(value: IOperation): ITabSnapshot {
    return {
        source: { kind: 'operation', id: value.operationId, projectId: value.projectId },
        rows: [
            {
                id: value.operationId,
                order: value.finishedAt ?? value.startedAt ?? '',
                stamp: `${value.state}:${value.systemRole?.phase ?? ''}`,
                state: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'CONFLICT'].includes(value.state)
                    ? 'terminal'
                    : value.state === 'RUNNING' && value.systemRole?.phase === 'awaiting_review'
                      ? 'attention'
                      : 'pending',
            },
        ],
    };
}

/** A direct role receipt names the same authorized operation read by the global queue. */
export function roleOperationTabSnapshot(run: IRoleRun): ITabSnapshot {
    const state =
        run.state === 'queued'
            ? 'QUEUED'
            : ['running', 'awaiting_review', 'applying'].includes(run.state)
              ? 'RUNNING'
              : run.state === 'succeeded'
                ? 'SUCCEEDED'
                : run.state === 'cancelled'
                  ? 'CANCELLED'
                  : ['failed', 'interrupted'].includes(run.state)
                    ? 'FAILED'
                    : run.state.toUpperCase();
    return {
        source: { kind: 'operation', id: run.operationId, projectId: run.projectId },
        rows: [
            {
                id: run.operationId,
                order: run.finishedAt ?? run.createdAt,
                stamp: `${state}:${run.phase}`,
                state:
                    run.state === 'awaiting_review'
                        ? 'attention'
                        : ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.state)
                          ? 'terminal'
                          : 'pending',
            },
        ],
    };
}
