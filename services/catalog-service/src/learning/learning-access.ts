import {ForbiddenException,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {Request} from 'express';
import {roleLevel,type IAccessActor} from '../access/access.model';

/** Lifecycle, role revocation and the following mutation share one transaction. */
export async function authorizeLearning(db:Pick<PoolClient,'query'>,actor:IAccessActor,projectId:string,minimumLevel:number):Promise<void>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:project-lifecycle:'||$1,0))",[projectId]);
    if(!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE',[projectId])).rows.length)throw new NotFoundException('Проект отсутствует.');
    if((await db.query('SELECT 1 FROM project_retirements WHERE project_id=$1',[projectId])).rows.length)throw new ForbiddenException('Проект выведен из эксплуатации.');
    const account=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',[actor.email])).rows[0];
    if(!account?.enabled)throw new ForbiddenException('Учётная запись отключена.');
    if(actor.activeRole==='Главный админ'){
        if(account.is_main_admin)return;throw new ForbiddenException('Права главного администратора отозваны.');
    }
    const grant=(await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[projectId,actor.email])).rows[0];
    if(Math.min(roleLevel(grant?.role),roleLevel(actor.activeRole))<minimumLevel)throw new ForbiddenException('Активная роль не разрешает это действие в проектном обучении.');
}

/** A personal device token can report observations, but cannot stand in for human approval. */
export function requireLearningHuman(req:Request):void{
    if(req.headers.authorization||req.headers['x-neurocenter-device-id'])throw new ForbiddenException('Проверку и применение подтверждает человек через интерфейс проекта.');
}
