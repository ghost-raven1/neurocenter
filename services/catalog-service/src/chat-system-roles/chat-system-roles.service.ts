import { ConflictException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { RoleDb } from '../system-roles/system-role.repository';
import { ModelsService } from '../models/models.service';
import { SystemRoleService } from '../system-roles/system-role.service';
import type { SystemDialog, SystemDialogRow } from '../system-role-chat/system-role-chat.types';
import { chatSystemRoleOrigin } from './chat-system-roles.validation';
import type { ChatSystemRoleOrigin } from './chat-system-roles.types';

/** A single private system dialog belongs to each human and saved origin; shared chats receive no posts. */
@Injectable()
export class ChatSystemRolesService {
    constructor(
        private readonly models: ModelsService,
        private readonly roles: SystemRoleService,
    ) {}
    private async saved(db: RoleDb, owner: string, origin: ChatSystemRoleOrigin): Promise<SystemDialogRow | undefined> {
        return (
            await db.query<SystemDialogRow>(
                `SELECT d.* FROM chat_system_role_origins o JOIN system_role_dialogs d ON d.id=o.dialog_id AND d.owner_email=o.owner_email
            WHERE o.owner_email=$1 AND o.origin_kind=$2 AND o.origin_id=$3 AND o.project_id IS NOT DISTINCT FROM $4`,
                [owner, origin.kind, origin.originId, origin.projectId],
            )
        ).rows[0];
    }
    private view(row: SystemDialogRow): SystemDialog {
        return {
            id: row.id,
            projectId: row.project_id,
            title: row.title,
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
        };
    }
    async read(req: Request, raw: unknown): Promise<SystemDialog | null> {
        await this.models.ready();
        const origin = chatSystemRoleOrigin(raw),
            actor = await this.models.actor(req);
        const row = await this.saved(this.models.pool, actor.email, origin);
        // Access to one's private role history survives origin deletion and feature OFF.
        await this.roles.policy.actor(req, row?.project_id ?? origin.projectId, 1);
        return row ? this.view(row) : null;
    }
    async bind(req: Request, raw: unknown): Promise<SystemDialog> {
        await this.models.ready();
        const origin = chatSystemRoleOrigin(raw),
            actor = await this.models.actor(req);
        await this.roles.policy.actor(req, origin.projectId, 1);
        const row = await this.roles.repository.transaction(async (db) => {
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
                JSON.stringify([
                    'chat-system-role-origin',
                    actor.email,
                    origin.kind,
                    origin.originId,
                    origin.projectId,
                ]),
            ]);
            const existing = await this.saved(db, actor.email, origin);
            if (existing) {
                await this.roles.policy.actor(req, existing.project_id, 1);
                return existing;
            }
            throw new ConflictException(
                'Откройте отдельный чат выбранной системной роли через «Чат роли». Прежняя история сохранена.',
            );
        });
        return this.view(row);
    }
}
