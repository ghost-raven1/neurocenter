import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Pool, PoolClient } from 'pg';
import { assertInternal } from '../access/access.controller';
import {
    canReadCommon,
    normalizeEmail,
    projectLevel,
    roleLevel,
    type IAccessActor,
    type IAccessClaims,
} from '../access/access.model';
import { HelpService } from '../help/help.service';
import type { DiscussionTarget } from './discussions.types';
type Db = Pick<PoolClient | Pool, 'query'>;
export interface DiscussionActor extends IAccessActor {
    claims: IAccessClaims;
    displayName: string;
}

/** Target visibility and mutations use current database grants, independently of feature switches. */
@Injectable()
export class DiscussionsPolicy {
    constructor(private readonly help: HelpService) {}
    input(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        try {
            const actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')));
            return { email: normalizeEmail(actor.email), activeRole: actor.activeRole };
        } catch {
            throw new BadRequestException('Не подтверждён пользователь обсуждения.');
        }
    }
    async actor(db: Db, actor: IAccessActor, lock = false): Promise<DiscussionActor> {
        const suffix = lock ? ' FOR SHARE' : '';
        const user = (
            await db.query<{ enabled: boolean; is_main_admin: boolean; display_name: string }>(
                'SELECT enabled,is_main_admin,display_name FROM platform_users WHERE email=$1' + suffix,
                [actor.email],
            )
        ).rows[0];
        if (!user?.enabled || !roleLevel(actor.activeRole))
            throw new ForbiddenException('Доступ пользователя отозван.');
        const projects = (
            await db.query<{ projectId: string; projectName: string; role: string }>(
                'SELECT pm.project_id AS "projectId",p.name AS "projectName",pm.role FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE lower(pm.principal_name)=$1' +
                    suffix,
                [actor.email],
            )
        ).rows;
        const userRoles = [
            ...new Set([...projects.map((row) => row.role), ...(user.is_main_admin ? ['Главный админ'] : [])]),
        ];
        if (!userRoles.includes(actor.activeRole)) throw new ForbiddenException('Выбранная роль больше не доступна.');
        return {
            ...actor,
            displayName: user.display_name,
            claims: { email: actor.email, projects, userRoles, pluginIds: [], skillPaths: [] },
        };
    }
    /** Reuses exact skill visibility before and after the external catalog wait. */
    private async skillScope(db: Db, actor: DiscussionActor, id: string, write: boolean): Promise<void> {
        const projects = actor.claims.projects
            .filter((row) => Math.min(roleLevel(row.role), roleLevel(actor.activeRole)) > 0)
            .map((row) => row.projectId);
        const assigned = !!(
            await db.query(
                "SELECT 1 FROM project_assets WHERE asset_kind='skill' AND asset_id=$1 AND project_id=ANY($2::text[])" +
                    (write ? ' FOR SHARE' : ''),
                [id, projects],
            )
        ).rowCount;
        const nativeScope = /^project-(.+)$/.exec(id.split('/')[0])?.[1];
        const native = !!nativeScope && projectLevel(actor.claims, actor.activeRole, nativeScope) > 0;
        if (!assigned && !native && !(canReadCommon(actor.claims, actor.activeRole) && id.startsWith('common/')))
            throw new NotFoundException('Карточка недоступна.');
    }
    async target(db: Db, actor: DiscussionActor, target: DiscussionTarget, write = false): Promise<void> {
        if (target.type === 'help') {
            await this.help.files.read(target.id);
            return;
        }
        const split = target.id.indexOf(':'),
            kind = target.id.slice(0, split),
            id = target.id.slice(split + 1),
            common = canReadCommon(actor.claims, actor.activeRole);
        const projects = actor.claims.projects
            .filter((row) => Math.min(roleLevel(row.role), roleLevel(actor.activeRole)) > 0)
            .map((row) => row.projectId);
        const lock = write ? ' FOR SHARE' : '';
        // A revoked assignment cannot race a write after the visibility check.
        if (write && !common) {
            if (kind === 'mcp' || kind === 'plugin' || kind === 'skill')
                await db.query(
                    'SELECT asset_id FROM project_assets WHERE asset_id=$1 AND asset_kind=$2 AND project_id=ANY($3::text[]) FOR SHARE',
                    [id, kind, projects],
                );
            if (kind === 'model')
                await db.query(
                    'SELECT model_id FROM project_models WHERE model_id=$1 AND project_id=ANY($2::text[]) FOR SHARE',
                    [id, projects],
                );
            if (kind === 'agent')
                await db.query(
                    'SELECT agent_id FROM project_agents WHERE agent_id=$1 AND NOT removed AND project_id=ANY($2::text[]) FOR SHARE',
                    [id, projects],
                );
        }
        let available = false;
        if (kind === 'mcp' || kind === 'plugin')
            available = !!(
                await db.query(
                    `SELECT id FROM ai_plugins WHERE id=$1 AND kind=$2 AND ($3 OR EXISTS(SELECT 1 FROM project_assets a WHERE a.asset_id=ai_plugins.id AND a.asset_kind=ai_plugins.kind AND a.project_id=ANY($4::text[])))` +
                        (write ? ' AND archived_at IS NULL' : '') +
                        lock,
                    [id, kind, common, projects],
                )
            ).rowCount;
        else if (kind === 'model')
            available = !!(
                await db.query(
                    `SELECT id FROM model_catalog WHERE id=$1 AND ($2 OR EXISTS(SELECT 1 FROM project_models a WHERE a.model_id=model_catalog.id AND a.project_id=ANY($3::text[])))` +
                        (write ? ' AND archived_at IS NULL' : '') +
                        lock,
                    [id, common, projects],
                )
            ).rowCount;
        else if (kind === 'agent')
            available = !!(
                await db.query(
                    `SELECT id FROM agent_catalog WHERE id=$1 AND ($2 OR EXISTS(SELECT 1 FROM project_agents a WHERE a.agent_id=agent_catalog.id AND NOT a.removed AND a.project_id=ANY($3::text[])))` +
                        (write ? ' AND archived_at IS NULL' : '') +
                        lock,
                    [id, common, projects],
                )
            ).rowCount;
        else if (kind === 'skill') {
            if (!/^[a-z0-9][a-z0-9_/-]*$/.test(id) || id.split('/').some((part) => !part || part === '..'))
                throw new BadRequestException('Некорректный адрес скилла.');
            await this.skillScope(db, actor, id, write);
            const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
            if (!token) throw new ServiceUnavailableException('Каталог скиллов не настроен.');
            try {
                const response = await fetch(
                    (process.env.SKILLS_SERVICE_URL || 'http://localhost:4200').replace(/\/$/, '') + '/api/skills',
                    {
                        headers: { 'x-neurocenter-internal': token },
                        redirect: 'error',
                        signal: AbortSignal.timeout(10000),
                    },
                );
                if (!response.ok) throw Error();
                const data: unknown = await response.json();
                if (!Array.isArray(data)) throw Error();
                available = data.some((row) => row?.path === id && (!write || !row?.meta?.archivedAt));
            } catch {
                throw new ServiceUnavailableException('Не удалось проверить доступность скилла. Повторите позже.');
            }
            await this.skillScope(db, await this.actor(db, actor, write), id, write);
        }
        if (!available) throw new NotFoundException('Карточка удалена или недоступна в текущей роли.');
    }
}
