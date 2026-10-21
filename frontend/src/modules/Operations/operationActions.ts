import type { IOperation } from '../../core/api/interfaces';
import type { IUserInfo } from '../../core/interfaces';
import { projectRoleLevel } from '../../features/UserBlock/roles';
import { operationKnowledgeRecovery, requiresKnowledgeResync } from './operationKnowledgeRecovery';

const BRIDGE_JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Действия доступны только для реальной личной очереди; журнал не подменяет её состояние. */
export function operationActions(operation: IOperation, email: string, canWrite: boolean, canRetry = canWrite) {
    const capabilities=operation.actions;
    const own = !!email && operation.actor === email && !!capabilities && /^[a-f0-9]{64}$/.test(capabilities.digest)
        && (capabilities.executor==='bridge'&&operation.resourceType==='bridge'&&BRIDGE_JOB_ID.test(operation.resourceId)
            ||capabilities.executor==='rag-reindex'&&operation.resourceType==='rag-reindex');
    const recovery = operationKnowledgeRecovery(operation);
    return {
        cancel: own && capabilities!.cancel.supported && (capabilities!.executor==='bridge'?operation.state==='QUEUED':canWrite),
        retry: own && canRetry && capabilities!.retry.supported && (capabilities!.executor!=='bridge'||operation.bridgeJob?.retrySupported===true&&['FAILED','CANCELLED'].includes(operation.state)) && !requiresKnowledgeResync(operation),
        reopenKnowledge: !!email&&operation.actor===email&&canWrite&&!!recovery,
    };
}

/** Отзыв активной роли блокирует и уже открытое подтверждение действия. */
export function operationActionPermissions(operation: IOperation, user: IUserInfo | null) {
    if (!user || !user.userRoles.includes(user.activeRole)
        || (operation.projectId && projectRoleLevel(user, operation.projectId) < 1)) {
        return { cancel: false, retry: false, reopenKnowledge: false };
    }
    const rag=operation.actions?.executor==='rag-reindex';
    const canWrite = !operation.projectId || projectRoleLevel(user, operation.projectId) >= (rag?3:2);
    const minimum = rag?3:operation.bridgeJob?.minimumLevel;
    const canRetry = (minimum === 1 || minimum === 2 ||rag&&minimum===3)
        && (!operation.projectId || projectRoleLevel(user, operation.projectId) >= minimum);
    return operationActions(operation, user.email, canWrite, canRetry);
}

/** Владелец действия включает назначения: прежнее подтверждение нельзя перенести на новые права. */
export function operationActionScope(user: IUserInfo | null): string {
    return user ? JSON.stringify([
        user.id, user.email, user.activeRole, [...user.userRoles].sort(),
        user.projectRoles.map(role => [role.projectId, role.projectName, role.role]).sort(),
        [...user.routePermissions].sort(),
    ]) : '';
}
