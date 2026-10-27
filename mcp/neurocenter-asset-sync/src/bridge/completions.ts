import {MEMORY_SYNC_CAPABILITY} from '../features/project-learning-memory-sync/contract.js';
import {acknowledgeMemoryCheckpoint} from '../features/project-learning-memory-sync/receipts.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { api, stateDir, readState, type Credentials } from './state.js';
import { atomicText, syncDirectory } from './atomic-file.js';
import { readBoundedUtf8 } from './read-bounded.js';
import {DEVICE_CODEX_PROTOCOL} from '../features/device-codex-inference/contract.js';
import {acknowledgeCodexReceipt,codexDeliveryResult} from '../features/device-codex-inference/receipts.js';
import {acknowledgeRuntimeCachePolicyReceipt} from '../features/runtime-artifacts/cache-policy.js';
import {AGENT_METHOD_WORKFLOW_PROTOCOL} from '../features/agent-method-workflow/contract.js';
import {acknowledgeMethodReceipt,methodDeliveryResult} from '../features/agent-method-workflow/receipts.js';

export interface Completion {
    id: string;
    lease: string;
    deviceId?: string;
    state: 'succeeded' | 'failed';
    message: string;
    result: Record<string, unknown>;
}
const uuid = /^[-a-f0-9]{36}$/;
const directory = () => path.join(stateDir(), 'completions');
function validate(value: unknown): Completion {
    const item = value as Completion | null;
    if (!item || !uuid.test(item.id) || !uuid.test(item.lease)
        || (item.deviceId !== undefined && !uuid.test(item.deviceId))
        || !['succeeded', 'failed'].includes(item.state)
        || typeof item.message !== 'string' || item.message.length > 1500
        || !item.result || typeof item.result !== 'object' || Array.isArray(item.result)
        || Buffer.byteLength(JSON.stringify(item.result)) > (item.result.schemaVersion === 1 && (item.result.status === 'prepared' || Array.isArray(item.result.entries)) ? 512 * 1024 : 10000)) {
        throw new Error('Повреждено локальное подтверждение задания MCP.');
    }
    return item;
}

/** Результат сохраняется до отправки; ошибка сети не меняет факт локальной записи. */
export async function saveCompletion(completion: Completion): Promise<void> {
    // Открытие отчёта тоже содержит changePlanId, но не является квитанцией изменения asset.
    if (completion?.result && typeof completion.result.changePlanId === 'string' && typeof completion.result.assetId === 'string') {
        const allowed = ['projectId','assetId','version','manifest','bindingId','changePlanId','digest','files','changed','packages','readiness','rolledBack','unchanged'];
        completion = {...completion,result:Object.fromEntries(Object.entries(completion.result).filter(([key])=>allowed.includes(key))),
            message:completion.state === 'succeeded' ? 'Локальное действие завершено; предыдущее состояние сохранено.' : 'Локальное действие не выполнено; предыдущее состояние сохранено.'};
    }
    validate(completion);
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    const destination = path.join(directory(), completion.id + '.json');
    try {
        const previous = validate(JSON.parse(await readBoundedUtf8(destination, 600 * 1024)));
        if (previous.lease !== completion.lease || previous.state !== completion.state) {
            throw new Error('Результат задания уже зафиксирован иначе.');
        }
        await syncDirectory(directory());
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
    await atomicText(destination, JSON.stringify(completion), 0o600);
}

export async function pendingCompletions(): Promise<Completion[]> {
    const files = await fs.readdir(directory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return []; }
        throw error;
    });
    const items: Completion[] = [];
    for (const file of files.filter(file => /^[-a-f0-9]{36}\.json$/.test(file)).sort()) {
        const completion = validate(JSON.parse(await readBoundedUtf8(path.join(directory(), file), 600 * 1024)));
        if (file !== completion.id + '.json') { throw new Error('Имя подтверждения не соответствует заданию.'); }
        items.push(completion);
    }
    return items;
}

/** Повторяется только отчёт: сами файлы и конфигурация повторно не изменяются. */
export async function deliverCompletions(
    send: (item: Completion) => Promise<unknown> = item => api(`jobs/${item.id}/complete`, item),
): Promise<void> {
    const credentials = await readState<Credentials>('credentials');
    for (const item of await pendingCompletions()) {
        if (item.deviceId && credentials && item.deviceId !== credentials.deviceId) {
            const archive = path.join(directory(), 'previous-devices');
            await fs.mkdir(archive, { recursive: true, mode: 0o700 });
            await fs.rename(path.join(directory(), item.id + '.json'), path.join(archive, item.id + '.json'));
            if(item.result.protocol===DEVICE_CODEX_PROTOCOL)await acknowledgeCodexReceipt(item.id,String(item.result.callId));
            if(item.result.protocol===MEMORY_SYNC_CAPABILITY)await acknowledgeMemoryCheckpoint(item.id);
            if(item.result.protocol===AGENT_METHOD_WORKFLOW_PROTOCOL)await acknowledgeMethodReceipt(item.id,String(item.result.workflowId));
            await acknowledgeRuntimeCachePolicyReceipt(item.id);
            continue;
        }
        const delivered=item.result.protocol===DEVICE_CODEX_PROTOCOL
            ? {...item,result:await codexDeliveryResult(item.id,item.deviceId,String(item.result.callId))}
            : item.result.protocol===AGENT_METHOD_WORKFLOW_PROTOCOL
            ? {...item,result:{...await methodDeliveryResult(item.id,item.deviceId,String(item.result.workflowId))}}
            : item;
        await send(delivered);
        if(item.result.protocol===DEVICE_CODEX_PROTOCOL)await acknowledgeCodexReceipt(item.id,String(item.result.callId));
        if(item.result.protocol===MEMORY_SYNC_CAPABILITY)await acknowledgeMemoryCheckpoint(item.id);
        if(item.result.protocol===AGENT_METHOD_WORKFLOW_PROTOCOL)await acknowledgeMethodReceipt(item.id,String(item.result.workflowId));
        // В pending index входят и отказы до записи, результат которых пуст.
        await acknowledgeRuntimeCachePolicyReceipt(item.id);
        await fs.rm(path.join(directory(), item.id + '.json'), { force: true });
    }
}

export async function previousDeviceCompletions(): Promise<number> {
    return (await fs.readdir(path.join(directory(), 'previous-devices')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') { return []; } throw error;
    })).filter(file => file.endsWith('.json')).length;
}
