import {ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {roleLevel,type IAccessActor} from '../access/access.model';
/** Row locks keep revocation and the associated write in one authorization boundary. */
export async function authorizeAgentWrite(db:Pick<PoolClient,'query'>,actor:IAccessActor,projectId?:string):Promise<void>{
    const account=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[actor.email])).rows[0];
    if(!account?.enabled)throw new ForbiddenException('Учётная запись отключена.');
    if(actor.activeRole==='Главный админ'){if(account.is_main_admin)return;throw new ForbiddenException('Права главного администратора отозваны.');}
    if(!projectId)throw new ForbiddenException('Общим каталогом агентов управляет главный администратор.');
    const grant=(await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[projectId,actor.email])).rows[0];
    if(Math.min(roleLevel(grant?.role),roleLevel(actor.activeRole))<3)throw new ForbiddenException('Настройки агентов изменяет администратор проекта.');
}
