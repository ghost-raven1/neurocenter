import { ConflictException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { recordDeviceOperation } from './device-operations';
import { publishMethodChatResult } from '../agent-method-workflows/chat-origin';

interface WorkspaceChange {
    deviceId: string;
    projectId?: string;
    email: string;
    kind: string;
}
const workspaceKinds = ['choose-root', 'bind-project', 'transfer-workspace', 'adopt-workspace'];

/** Смена папки не перенаправляет прежнюю очередь и ждёт завершения начатых действий. */
export async function guardWorkspaceQueue(client: PoolClient, input: WorkspaceChange): Promise<void> {
    if (!workspaceKinds.includes(input.kind)) {
        return;
    }
    const projectId = input.kind === 'choose-root' ? null : input.projectId;
    const { rows: active } = await client.query(
        `SELECT id FROM bridge_jobs WHERE device_id=$1
        AND ($2::text IS NULL OR project_id=$2) AND state IN ('running','reconciling') LIMIT 1 FOR UPDATE`,
        [input.deviceId, projectId],
    );
    if (active.length) {
        throw new ConflictException(
            'Сначала дождитесь завершения или сверки начатого действия. Затем измените папку проекта.',
        );
    }
    const { rows } = await client.query<{ id: string; kind: string; email: string; project_id: string | null }>(
        `UPDATE bridge_jobs SET state='cancelled',message='Папка меняется. Повторите действие для новой привязки.',updated_at=now()
        WHERE device_id=$1 AND ($2::text IS NULL OR project_id=$2) AND state='queued' RETURNING id,kind,email,project_id`,
        [input.deviceId, projectId],
    );
    for (const job of rows) {
        await publishMethodChatResult(client, job);
        await recordDeviceOperation(
            client,
            job,
            'CANCELLED',
            0,
            'Папка меняется. Повторите действие для новой привязки.',
        );
    }
}
