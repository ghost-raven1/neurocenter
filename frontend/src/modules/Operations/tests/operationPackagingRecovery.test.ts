import { expect, it } from 'vitest';
import { operationPackagingRecovery } from '../operationPackagingRecovery';
import type { IOperation } from '../../../core/api/interfaces';
import type { IUserInfo } from '../../../core/interfaces';

const user: IUserInfo = {
    id: 'owner',
    principalName: 'owner',
    email: 'owner@example.test',
    displayName: 'Owner',
    projectRoles: [],
    userRoles: ['Главный админ'],
    activeRole: 'Главный админ',
    routePermissions: [],
};
const operation: IOperation = {
    operationId: 'tool-build-11111111-1111-4111-8111-111111111111',
    resourceId: '11111111-1111-4111-8111-111111111111',
    resourceType: 'tool-build',
    type: 'BUILD',
    projectId: null,
    actor: user.email,
    state: 'FAILED',
    percent: 10,
    bytesDone: 0,
    bytesTotal: 0,
    startedAt: null,
    finishedAt: null,
    error: 'Failed',
    toolBuildSource: { id: 'recipe', revision: 'pinned' },
};
it('links a bundled failure to its exact recipe and build journal', () => {
    expect(operationPackagingRecovery(operation, user)).toBe(
        '/assets?prepare=recipe&recoverBuild=11111111-1111-4111-8111-111111111111',
    );
    expect(operationPackagingRecovery({ ...operation, state: 'CANCELLED', projectId: 'project-one' }, user)).toContain(
        '&p=project-one',
    );
});
it('keeps the generic recovery route for legacy and nonbundled builds', () => {
    expect(operationPackagingRecovery({ ...operation, toolBuildSource: undefined }, user)).toBe(
        '/store?packaging=open',
    );
});
it('does not offer creation to an inactive admin role or a nonterminal job', () => {
    expect(operationPackagingRecovery(operation, { ...user, activeRole: 'Наблюдатель' })).toBeUndefined();
    expect(operationPackagingRecovery(operation, { ...user, userRoles: [] })).toBeUndefined();
    expect(operationPackagingRecovery({ ...operation, state: 'SUCCEEDED' }, user)).toBeUndefined();
});
