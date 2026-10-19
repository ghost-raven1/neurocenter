import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';
import { projectRoleLevel } from '../../features/UserBlock/roles';

const BRIDGE_JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Действия доступны только для реальной личной очереди; журнал не подменяет её состояние. */
export function operationActions(operation: IOperation, email: string, canWrite: boolean) {
    const own = !!email && operation.resourceType === 'bridge'
        && operation.actor === email && BRIDGE_JOB_ID.test(operation.resourceId);
    return {
        cancel: own && operation.state === 'QUEUED',
        retry: own && canWrite && ['FAILED', 'CANCELLED'].includes(operation.state),
    };
}

/** Отзыв активной роли блокирует и уже открытое подтверждение действия. */
export function operationActionPermissions(operation: IOperation, user: IUserInfo | null) {
    if (!user || !user.userRoles.includes(user.activeRole)) {
        return { cancel: false, retry: false };
    }
    const canWrite = !operation.projectId || projectRoleLevel(user, operation.projectId) >= 2;
    return operationActions(operation, user.email, canWrite);
}

/** Владелец действия включает назначения: прежнее подтверждение нельзя перенести на новые права. */
export function operationActionScope(user: IUserInfo | null): string {
    return user ? JSON.stringify([
        user.id, user.email, user.activeRole, [...user.userRoles].sort(),
        user.projectRoles.map(role => [role.projectId, role.projectName, role.role]).sort(),
        [...user.routePermissions].sort(),
    ]) : '';
}
