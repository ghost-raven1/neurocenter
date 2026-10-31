import { ConflictException } from '@nestjs/common';
import { systemDialogContext, type DialogContextReference } from '../system-role-chat/system-role-chat.context';
import type { RoleDb } from './system-role.repository';
const uuid = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
/** An explicit context receipt references at most five completed own-dialog answers; live ACL and revisions are rechecked. */
export async function readRoleDialogContext(db: RoleDb, actor: string, project: string | null, id: string) {
    const changed = (): never => {
        throw new ConflictException('Контекст личного диалога изменился или недоступен. Подготовьте его заново.');
    };
    if (!uuid(id)) return changed();
    const row = (
        await db.query<{ dialog_id: string; refs: DialogContextReference[]; pin: string }>(
            `SELECT c.dialog_id,c.refs,c.pin FROM system_role_dialog_contexts c JOIN system_role_dialogs d ON d.id=c.dialog_id
        WHERE c.id=$1 AND c.owner_email=$2 AND d.owner_email=$2 AND d.project_id IS NOT DISTINCT FROM $3`,
            [id, actor, project],
        )
    ).rows[0];
    if (
        !row ||
        !Array.isArray(row.refs) ||
        !row.refs.length ||
        row.refs.length > 5 ||
        new Set(row.refs.map((ref) => ref?.id)).size !== row.refs.length ||
        row.refs.some(
            (ref) =>
                !ref ||
                Object.keys(ref).sort().join(',') !== 'id,revision' ||
                !uuid(ref.id) ||
                !Number.isSafeInteger(ref.revision) ||
                ref.revision < 0,
        )
    )
        return changed();
    const current = await systemDialogContext(db, actor, row.dialog_id, row.refs);
    if (current.pin !== row.pin) return changed();
    return { ...current, dialogId: row.dialog_id };
}
