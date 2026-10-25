import type {RoleOverview, RoleRun, RoleStart} from '../src/features/SystemRoles/types';
import type {ServiceDetail, ServiceTurn} from '../src/features/SystemRoleChat/types';

export const notificationRoleRun = (patch: Partial<RoleRun> = {}): RoleRun => ({
    id: 'run-one', agentId: 'agent-ai-admin', projectId: 'prj-one', actor: 'alice@example.test', state: 'awaiting_review', phase: 'awaiting_review', revision: 3,
    operationId: 'system-role-run-one', message: 'Предложение готово', createdAt: '2026-10-25T00:00:00Z', finishedAt: null, callsStarted: 1,
    modelId: 'model-one', modelPin: 'a'.repeat(64), facts: [], result: {kind: 'proposal', summary: 'Проверенное предложение', findings: [], nextSteps: [], changes: []},
    steps: [], applied: [], targets: [], canApply: true, canCancel: false, canRollback: false, ...patch,
});
export const notificationServiceTurn = (run = notificationRoleRun()): ServiceTurn => ({id: 'request-one', agentId: run.agentId, instruction: 'Проверь проект', createdAt: run.createdAt, cancelRequested: false, run});
export const notificationServiceDetail = (): ServiceDetail => ({dialog: {id: 'dialog-one', projectId: 'prj-one', title: 'Задача', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z'}, turns: [notificationServiceTurn()]});
export const notificationRoleOverview: RoleOverview = {definitions: [], budget: {calls: 2, diagnostics: 2, targets: 2, deadlineMs: 60000}, models: [], targets: [], projectId: 'prj-one'};
export const notificationRoleInput: RoleStart = {projectId: 'prj-one', instruction: 'Проверь проект', diagnostics: [], targets: [], requestId: 'request-one', modelId: 'model-one',
    expectedModelPin: 'a'.repeat(64), expectedDefinitionPin: 'b'.repeat(64), consentDigest: 'c'.repeat(64)};
