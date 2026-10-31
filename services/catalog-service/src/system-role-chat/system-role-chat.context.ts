import { ConflictException, NotFoundException } from '@nestjs/common';
import { roleHash } from '../system-roles/system-role.definitions';
import type { PoolClient } from 'pg';
type SystemDialogDb = Pick<PoolClient, 'query'>;
export interface DialogContextReference {
    id: string;
    revision: number;
}
interface ContextRow {
    id: string;
    agent_id: string;
    instruction: string;
    run_id: string;
    revision: number;
    result: { summary: string };
}
/** A context receipt keeps references only. Every model checkpoint resolves the same completed own-dialog answers again. */
export async function systemDialogContext(
    db: SystemDialogDb,
    owner: string,
    dialogId: string,
    references?: DialogContextReference[],
) {
    const dialog = (
        await db.query('SELECT id FROM system_role_dialogs WHERE id=$1 AND owner_email=$2', [dialogId, owner])
    ).rows[0];
    if (!dialog) throw new NotFoundException('Контекст личного диалога недоступен.');
    const values = (
        await db.query<ContextRow>(
            `SELECT i.id,i.agent_id,i.input->>'instruction' AS instruction,r.id AS run_id,r.revision,r.result
        FROM system_role_dialog_intents i JOIN system_role_dialogs d ON d.id=i.dialog_id AND d.owner_email=i.owner_email
        JOIN system_role_runs r ON r.id=i.run_id AND r.actor=i.owner_email AND r.agent_id=i.agent_id AND r.project_id IS NOT DISTINCT FROM d.project_id
        WHERE i.dialog_id=$1 AND i.owner_email=$2 AND r.state IN ('succeeded','awaiting_review') AND r.result IS NOT NULL
        AND ($3::uuid[] IS NULL OR i.id=ANY($3)) ORDER BY i.created_at DESC,i.id DESC LIMIT 5`,
            [dialogId, owner, references?.map((value) => value.id) ?? null],
        )
    ).rows.reverse();
    if (
        references &&
        (references.length !== values.length ||
            references.some((ref) => !values.some((row) => row.id === ref.id && row.revision === ref.revision)))
    )
        throw new ConflictException('Контекст диалога изменился. Проверьте и подтвердите его заново.');
    if (!values.length) throw new ConflictException('В диалоге пока нет завершённых ответов для контекста.');
    const snapshot = () =>
        values.map((row) => ({
            id: row.id,
            revision: row.revision,
            role: row.agent_id,
            question: row.instruction,
            answer: row.result.summary.slice(0, 2048),
            answerTruncated: row.result.summary.length > 2048,
        }));
    while (!references && values.length > 1 && Buffer.byteLength(JSON.stringify(snapshot())) > 49152) values.shift();
    const messages = snapshot();
    if (Buffer.byteLength(JSON.stringify(messages)) > 49152) throw new ConflictException('Сократите контекст диалога.');
    const refs = values.map((row) => ({ id: row.id, revision: row.revision }));
    return { references: refs, messages, pin: roleHash({ references: refs, messages }) };
}
