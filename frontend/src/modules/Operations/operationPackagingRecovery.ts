import type {IOperation} from '../../core/api/interfaces';
import type {IUserInfo} from '../../core/interfaces';
import {isMainAdminRole} from '../../features/UserBlock/roles';

/** Неудачная сборка открывает форму нового запроса; старое задание не повторяется. */
export function operationPackagingRecovery(operation:IOperation,user:IUserInfo|null):string|undefined {
    if (!user || !user.userRoles.includes(user.activeRole) || !isMainAdminRole(user.activeRole)
        || operation.resourceType !== 'tool-build' || operation.type !== 'BUILD'
        || !['FAILED','CANCELLED'].includes(operation.state)) return;
    if (operation.projectId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(operation.projectId)) return;
    const query = new URLSearchParams({packaging:'open'});
    if (operation.projectId) query.set('p',operation.projectId);
    return `/store?${query}`;
}
