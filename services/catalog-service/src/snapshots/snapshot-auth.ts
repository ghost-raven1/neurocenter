import {ForbiddenException,NotFoundException} from '@nestjs/common';
import type {PoolClient} from 'pg';
import type {IAccessActor} from '../access/access.model';
import {roleLevel} from '../access/access.model';

/** Fresh SQL grants and the project are locked in the same transaction as a destructive command. */
export async function snapshotProject(client:PoolClient,projectId:string,actor:IAccessActor,minimum:number){
    const project=(await client.query('SELECT * FROM projects WHERE id=$1 FOR UPDATE',[projectId])).rows[0];
    if(!project)throw new NotFoundException('Проект не найден.');
    const account=(await client.query('SELECT is_main_admin,enabled FROM platform_users WHERE email=$1 FOR SHARE',[actor.email])).rows[0];
    if(!account?.enabled)throw new ForbiddenException('Учётная запись отключена.');
    if(actor.activeRole==='Главный админ'&&account.is_main_admin)return project;
    const members=await client.query('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE',[projectId,actor.email]);
    if(!members.rows.some(member=>member.role===actor.activeRole&&roleLevel(member.role)>=minimum))throw new ForbiddenException('Недостаточно актуальных прав на снимки проекта.');
    return project;
}
