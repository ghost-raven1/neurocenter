import fs from 'node:fs/promises';
import path from 'node:path';
import { hash, stateDir, readState, writeState } from '../../bridge/state.js';
import { syncDirectory } from '../../bridge/atomic-file.js';
import { readPrivateConfiguration, writePrivateConfiguration } from '../local-configuration/private-store.js';
import {
    closeRoleMcpProcess,
    findRoleMcpProcess,
    type RoleMcpProcessJournal,
} from '../system-role-mcp/owned-process.js';
import type { RoleMcpOwner } from '../system-role-mcp/session-journal.js';
import type { Completion } from '../../bridge/completions.js';
import {
    AGENT_METHOD_WORKFLOW_PROTOCOL,
    normalizeAgentMethodWorkflowResult,
    type AgentMethodWorkflowResult,
} from './contract.js';

export interface MethodReceipt {
    schemaVersion: 1;
    jobId: string;
    lease: string;
    deviceId: string;
    workflowId: string;
    payloadHash: string;
    state: 'started' | 'completed';
    result: AgentMethodWorkflowResult;
    process?: { nonce: string; receipt: string; owner?: RoleMcpOwner };
}
type Pointer = Omit<MethodReceipt, 'state' | 'process' | 'schemaVersion'>;
const indexName = 'agent-method-workflow-pending';
const receiptKey = (id: string) => hash('agent-method-workflow:' + id);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
async function pointers(): Promise<Pointer[]> {
    const value = (await readState<Pointer[]>(indexName)) ?? [];
    if (
        !Array.isArray(value) ||
        value.length > 64 ||
        Buffer.byteLength(JSON.stringify(value)) > 512 * 1024 ||
        value.some(
            (row) =>
                !row ||
                !uuid.test(row.jobId) ||
                !uuid.test(row.lease) ||
                !uuid.test(row.deviceId) ||
                !uuid.test(row.workflowId) ||
                !/^[a-f0-9]{64}$/.test(row.payloadHash),
        )
    )
        throw Error('Повреждена история локальных циклов разработки.');
    for (const pointer of value) normalizeAgentMethodWorkflowResult(pointer.result);
    return value;
}
export async function readMethodReceipt(workflowId: string): Promise<MethodReceipt | undefined> {
    const receipt = await readPrivateConfiguration<MethodReceipt>(receiptKey(workflowId));
    if (
        receipt &&
        (receipt.schemaVersion !== 1 ||
            receipt.workflowId !== workflowId ||
            !['started', 'completed'].includes(receipt.state))
    )
        throw Error('Квитанция цикла разработки повреждена.');
    if (receipt) normalizeAgentMethodWorkflowResult(receipt.result);
    return receipt;
}
/** The durable index precedes the private marker; no process may receive its execution permit before both are fsynced. */
export async function writeMethodReceipt(receipt: MethodReceipt, previous: MethodReceipt | undefined): Promise<void> {
    normalizeAgentMethodWorkflowResult(receipt.result);
    const pending = await pointers(),
        found = pending.find((row) => row.workflowId === receipt.workflowId);
    if (
        found &&
        (found.jobId !== receipt.jobId ||
            found.deviceId !== receipt.deviceId ||
            found.payloadHash !== receipt.payloadHash)
    )
        throw Error('Цикл разработки принадлежит другому заданию.');
    if (!found) {
        if (pending.length >= 64) throw Error('Сначала доставьте сохранённые результаты разработки.');
        const { schemaVersion: _schema, state: _state, process: _process, ...pointer } = receipt;
        await writeState(indexName, [...pending, pointer]);
    }
    await writePrivateConfiguration(receiptKey(receipt.workflowId), receipt, previous);
    await syncDirectory(path.join(stateDir(), 'local-configuration'));
}
/** Only an exact nonce, birth, UID and owned wrapper may be closed after a crash. */
export async function stopReceiptProcess(receipt: MethodReceipt): Promise<void> {
    const running = receipt.process;
    if (!running) return;
    const expected = path.join(stateDir(), 'agent-method-processes', running.nonce + '.json');
    if (!uuid.test(running.nonce) || running.receipt !== expected)
        throw Error('Владелец процесса разработки изменился.');
    const owner = running.owner ?? (await findRoleMcpProcess(running.nonce, running.receipt));
    if (owner) await closeRoleMcpProcess(owner, running.nonce, running.receipt);
}
export async function methodProcessJournal(
    receipt: MethodReceipt,
    save: (next: MethodReceipt) => Promise<void>,
): Promise<RoleMcpProcessJournal> {
    const { randomUUID } = await import('node:crypto'),
        nonce = randomUUID(),
        directory = path.join(stateDir(), 'agent-method-processes');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw Error('Небезопасная папка квитанций процессов.');
    const record = { nonce, receipt: path.join(directory, nonce + '.json') };
    await save({ ...receipt, process: record });
    return {
        ...record,
        retain: async (owner) => {
            await save({ ...receipt, process: { ...record, owner } });
        },
    };
}
export function methodCompletionSummary(receipt: MethodReceipt): Pick<Completion, 'state' | 'result' | 'message'> {
    return {
        state: receipt.result.state === 'succeeded' ? 'succeeded' : 'failed',
        result: { protocol: AGENT_METHOD_WORKFLOW_PROTOCOL, workflowId: receipt.workflowId },
        message:
            receipt.result.state === 'succeeded'
                ? 'Цикл разработки завершён; локальные изменения и проверки сохранены.'
                : receipt.result.state === 'needs_setup'
                  ? 'Настройте методику и локальный исполнитель, затем создайте новый запуск.'
                  : 'Цикл разработки не завершён; проверьте сохранённый результат перед новым запуском.',
    };
}
/** Recovery delivers the stored result; a started marker can never grant a second runtime dispatch. */
export async function recoverMethodCompletions(save: (value: Completion) => Promise<void>): Promise<void> {
    for (const pointer of await pointers()) {
        let receipt = await readMethodReceipt(pointer.workflowId);
        if (
            receipt &&
            (receipt.jobId !== pointer.jobId ||
                receipt.deviceId !== pointer.deviceId ||
                receipt.payloadHash !== pointer.payloadHash)
        )
            throw Error('Квитанция разработки принадлежит другому запуску.');
        if (receipt?.state !== 'completed') {
            if (receipt) await stopReceiptProcess(receipt);
            const result: AgentMethodWorkflowResult = {
                ...(receipt?.result ?? pointer.result),
                state: 'unknown',
                failure: { code: 'UNKNOWN_OUTCOME', action: 'inspect-workspace' },
            };
            const completed: MethodReceipt = { schemaVersion: 1, ...pointer, state: 'completed', result };
            await writeMethodReceipt(completed, receipt);
            receipt = completed;
        }
        await save({
            id: pointer.jobId,
            lease: pointer.lease,
            deviceId: pointer.deviceId,
            ...methodCompletionSummary(receipt),
        });
    }
}
export async function methodDeliveryResult(
    jobId: string,
    deviceId: string | undefined,
    workflowId: string,
): Promise<AgentMethodWorkflowResult> {
    const receipt = await readMethodReceipt(workflowId);
    if (!receipt || receipt.jobId !== jobId || receipt.deviceId !== deviceId || receipt.state !== 'completed')
        throw Error('Сохранённый результат разработки недоступен.');
    return normalizeAgentMethodWorkflowResult(receipt.result);
}
export async function acknowledgeMethodReceipt(jobId: string, workflowId: string): Promise<void> {
    const pending = await pointers();
    if (pending.some((row) => row.workflowId === workflowId && row.jobId !== jobId))
        throw Error('Подтверждение разработки принадлежит другому заданию.');
    await writeState(
        indexName,
        pending.filter((row) => row.workflowId !== workflowId || row.jobId !== jobId),
    );
}
