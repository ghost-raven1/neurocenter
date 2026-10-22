import {ForbiddenException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import {normalizeEmail,type IAccessActor} from './access.model';

/** Administrative writes serialize before role reads; share locks keep revocation ordered until COMMIT. */
export async function authorizeAccessWrite(db:Pick<PoolClient,'query'>,actor:IAccessActor,projectId?:string):Promise<IAccessActor>{
    let email:string;
    try{email=normalizeEmail(actor?.email);}catch{throw new ForbiddenException('Нужна действующая учётная запись администратора.');}
    await db.query('SELECT pg_advisory_xact_lock(72465381)');
    const account=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[email])).rows[0];
    if(!account?.enabled)throw new ForbiddenException('Учётная запись отключена или доступ отозван.');
    if(actor.activeRole==='Главный админ'){
        if(!account.is_main_admin)throw new ForbiddenException('Права главного администратора отозваны.');
    }else{
        if(actor.activeRole!=='Админ проекта'||!projectId)throw new ForbiddenException('Нужна активная роль администратора.');
        const grant=(await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[projectId,email])).rows[0];
        if(grant?.role!=='Админ проекта')throw new ForbiddenException('Права администратора проекта отозваны.');
    }
    return{email,activeRole:actor.activeRole};
}
