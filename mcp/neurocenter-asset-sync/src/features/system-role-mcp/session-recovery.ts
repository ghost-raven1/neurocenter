import type { IRoleMcpIdentity } from './api.js';
import { cleanRoleMcpSession, roleMcpClosurePath } from './local-session.js';
import { roleMcpOwnerAlive, retireRoleMcpProcessReceipt } from './owned-process.js';
import {
    readRoleMcpIntents,
    retainRoleMcpClaim,
    retainRoleMcpCompletion,
    retireRoleMcpIntent,
    type IRoleMcpSessionIntent,
} from './session-journal.js';
import type { ISessionJob } from './worker.js';

export interface IRoleMcpClaimRequest {
    requestId: string;
    recoveryOnly: boolean;
}
export function assertRoleMcpClaim(job: ISessionJob, requestId: string) {
    if (
        !job ||
        !/^[a-f0-9-]{36}$/.test(job.id) ||
        !/^[a-f0-9-]{36}$/.test(job.lease) ||
        job.payload?.sessionId !== job.id ||
        job.requestId !== requestId ||
        (job.recoveryOnly !== undefined && job.recoveryOnly !== true)
    )
        throw new Error('Сервер не подтвердил точный запрос сессии MCP.');
}
export async function acknowledgeRoleMcpCompletion(
    identity: IRoleMcpIdentity,
    intent: IRoleMcpSessionIntent,
    send: (job: ISessionJob, value: unknown, identity: IRoleMcpIdentity) => Promise<unknown>,
) {
    if (intent.phase !== 'closed' || !intent.completion || !intent.job)
        throw new Error('Нет подтверждения физической очистки MCP.');
    const { jobId: _, lease: __, ...value } = intent.completion,
        ack = (await send(intent.job, value, identity)) as { ok?: boolean; closed?: boolean };
    if (ack?.ok !== true || ack.closed !== true) throw new Error('Сервер не подтвердил завершение MCP.');
    if (intent.stdio)
        await retireRoleMcpProcessReceipt(intent.stdio, intent.nonce, await roleMcpClosurePath(identity, intent));
    await retireRoleMcpIntent(identity, intent);
}
/** A replay may close a lease, but never obtains authority to run its tool again. */
export async function recoverRoleMcpSessions(
    identity: IRoleMcpIdentity,
    active: Set<string>,
    claim: (request: IRoleMcpClaimRequest) => Promise<ISessionJob | null>,
    send: (job: ISessionJob, value: unknown, identity: IRoleMcpIdentity) => Promise<unknown>,
) {
    for (let intent of await readRoleMcpIntents(identity)) {
        if (active.has(intent.requestId)) continue;
        try {
            if (intent.phase === 'closed') {
                await acknowledgeRoleMcpCompletion(identity, intent, send);
                continue;
            }
            if (intent.owner.pid !== process.pid && (await roleMcpOwnerAlive(intent.owner))) continue;
            const recovered = await claim({ requestId: intent.requestId, recoveryOnly: true });
            if (!recovered) {
                // Null is a server-retired nonce: a delayed fresh request cannot allocate it.
                await cleanRoleMcpSession(identity, intent);
                await retireRoleMcpIntent(identity, intent);
                continue;
            }
            assertRoleMcpClaim(recovered, intent.requestId);
            if (
                recovered.recoveryOnly !== true ||
                (intent.job && (intent.job.id !== recovered.id || intent.job.lease !== recovered.lease))
            )
                throw new Error('Восстановление MCP изменило аренду.');
            if (intent.phase === 'pending') intent = await retainRoleMcpClaim(identity, intent, recovered);
            await cleanRoleMcpSession(identity, intent);
            intent = await retainRoleMcpCompletion(identity, intent, {
                jobId: recovered.id,
                lease: recovered.lease,
                state: 'failed',
                message: 'Мост восстановился после прерывания. Повторный запуск инструмента не выполнялся.',
                result: { schemaVersion: 1, sessionId: recovered.id, closed: true },
            });
            await acknowledgeRoleMcpCompletion(identity, intent, send);
        } catch {
            /* An uncertain receipt stays durable; independent sessions retain their own lane. */
        }
    }
}
