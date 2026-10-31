import { ConflictException, NotFoundException } from '@nestjs/common';
import type { RoleDb } from '../system-roles/system-role.repository';
import type { RoleRunRow, StartRoleRun, SystemRoleId } from '../system-roles/system-role.types';
import type { SystemDialogRow, SystemTurnRow } from './system-role-chat.types';

/** The dialog journal is a receipt over the role queue; it never owns another executor. */
export class SystemRoleChatRepository {
    constructor(readonly db: RoleDb) {}
    async dialogs(owner: string, project: string | null, agent?: SystemRoleId | null): Promise<SystemDialogRow[]> {
        return (
            await this.db.query<SystemDialogRow>(
                `SELECT d.* FROM system_role_dialogs d WHERE d.owner_email=$1 AND d.project_id IS NOT DISTINCT FROM $2
            AND ($3::text IS NULL OR d.agent_id=$3 OR (d.agent_id IS NULL AND EXISTS(SELECT 1 FROM system_role_dialog_intents i WHERE i.dialog_id=d.id AND i.owner_email=d.owner_email AND i.agent_id=$3)))
            ORDER BY d.updated_at DESC,d.id DESC LIMIT 100`,
                [owner, project, agent ?? null],
            )
        ).rows;
    }
    async dialog(id: string, owner: string, db = this.db, lock = false): Promise<SystemDialogRow> {
        const row = (
            await db.query<SystemDialogRow>(
                'SELECT * FROM system_role_dialogs WHERE id=$1 AND owner_email=$2' + (lock ? ' FOR NO KEY UPDATE' : ''),
                [id, owner],
            )
        ).rows[0];
        if (!row) throw new NotFoundException('Сервисный диалог недоступен.');
        return row;
    }
    async turns(dialog: string, owner: string, agent?: SystemRoleId | null): Promise<SystemTurnRow[]> {
        return (
            await this.db.query<SystemTurnRow>(
                'SELECT * FROM (SELECT * FROM system_role_dialog_intents WHERE dialog_id=$1 AND owner_email=$2 AND ($3::text IS NULL OR agent_id=$3) ORDER BY created_at DESC,id DESC LIMIT 100) recent ORDER BY created_at,id',
                [dialog, owner, agent ?? null],
            )
        ).rows;
    }
    async turn(dialog: string, owner: string, request: string, db = this.db): Promise<SystemTurnRow | undefined> {
        return (
            await db.query<SystemTurnRow>(
                'SELECT * FROM system_role_dialog_intents WHERE dialog_id=$1 AND owner_email=$2 AND request_id=$3',
                [dialog, owner, request],
            )
        ).rows[0];
    }
    async accept(
        db: RoleDb,
        dialog: SystemDialogRow,
        agent: SystemRoleId,
        input: StartRoleRun,
        hash: string,
    ): Promise<void> {
        // Same-key retries serialize on the immutable receipt before role admission and source validation.
        await db.query(
            `INSERT INTO system_role_dialog_intents(id,dialog_id,owner_email,request_id,agent_id,request_hash,input)
            VALUES($1,$2,$3,$1,$4,$5,$6::jsonb) ON CONFLICT(owner_email,request_id) DO NOTHING`,
            [input.requestId, dialog.id, dialog.owner_email, agent, hash, JSON.stringify(input)],
        );
        const saved = await this.turn(dialog.id, dialog.owner_email, input.requestId, db);
        if (!saved || saved.request_hash !== hash)
            throw new ConflictException('Ключ сообщения относится к другому запросу.');
    }
    async attach(db: RoleDb, row: RoleRunRow): Promise<void> {
        const source = row.request.source!;
        const attached = await db.query(
            `UPDATE system_role_dialog_intents SET run_id=$4 WHERE id=$1 AND dialog_id=$2 AND owner_email=$3 AND request_hash=$5 AND (run_id IS NULL OR run_id=$4) RETURNING id`,
            [source.turnId, source.dialogId, row.actor, row.id, row.request_hash],
        );
        if (!attached.rowCount) throw new ConflictException('Сообщение изменилось до принятия запуска.');
        await db.query('UPDATE system_role_dialogs SET updated_at=now() WHERE id=$1 AND owner_email=$2', [
            source.dialogId,
            row.actor,
        ]);
    }
}
