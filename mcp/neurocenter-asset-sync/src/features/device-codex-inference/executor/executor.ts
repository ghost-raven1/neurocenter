import { requestBody } from './utils.js';
import { isDeepStrictEqual } from 'node:util';
import { api, hash, hub, readState, type ICredentials } from '../../../bridge/state.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../../bridge/workspace.js';
import { loadDeviceCodexTransport, deviceCodexConnectorPackage } from '../../opencode-providers/connector.js';
import { prepareJobRuntimeArtifacts } from '../../../bridge/job-runtime-artifacts.js';
import { assertCodexModelSource } from '../model-source.js';
import {
    DEVICE_CODEX_PROTOCOL,
    normalizeDeviceCodexPayload,
    normalizeDeviceCodexContext,
    type DeviceCodexPayload,
    type DeviceCodexResult,
} from '../contract.js';
import { readCodexReceipt, writeCodexReceipt, codexCompletionSummary, type ICodexReceipt } from '../receipts.js';
import { readCodexResponse, CodexResponseFailure } from '../response.js';
import { RuntimeArtifactCapacityError } from '../../runtime-artifacts/capacity-error.js';
import {
    observeCodexHttp,
    sanitizeCodexDiagnostic,
    type ICodexDiagnostic,
    type TCodexDiagnosticStage,
} from '../diagnostics/diagnostics.js';

import type { ICodexJob, IExecutionDependencies } from './interfaces.js';

const defaults: IExecutionDependencies = {
    context: (job) => api('codex-inference/context', { jobId: job.id, lease: job.lease }),
    dispatch: (job, callId) => api('codex-inference/dispatch', { jobId: job.id, lease: job.lease, callId }),
    transport: loadDeviceCodexTransport,
    prepare: (context, authorize) =>
        prepareJobRuntimeArtifacts([deviceCodexConnectorPackage(context.connectorPackage)], authorize, async () => {}),
};
const failed = (
    callId: string,
    code: Extract<DeviceCodexResult, { error: unknown }>['error']['code'],
): DeviceCodexResult => ({ protocol: DEVICE_CODEX_PROTOCOL, callId, error: { code } });
const unavailable = () =>
    Object.assign(new Error('Результат Codex не сохранён. Повторная отправка модели заблокирована.'), {
        localChangesCommitted: true,
    });

async function localContext(deviceId: string, payload: DeviceCodexPayload) {
    const site = hub(),
        source = payload.source,
        root = source.scope === 'project' ? await projectFolder(source.projectId) : undefined;
    return async () => {
        if (hub() !== site || (await readState<ICredentials>('credentials'))?.deviceId !== deviceId)
            throw new Error('Подключение компьютера изменилось.');
        if (
            source.scope === 'project' &&
            ((await projectFolder(source.projectId)) !== root ||
                (await projectBindingId(source.projectId)) !== source.bindingId ||
                (await projectInstanceId(source.projectId)) !== source.instanceId)
        )
            throw new Error('Привязка проекта изменилась.');
    };
}
/** Dispatch is admitted once; recovery can replay only a private completed receipt, never the external model call. */
export async function runDeviceCodexJob(
    job: ICodexJob,
    deviceId: string,
    authorize: () => Promise<unknown>,
    dependencies: Partial<IExecutionDependencies> = {},
) {
    const payload = normalizeDeviceCodexPayload(job.payload),
        deps = { ...defaults, ...dependencies };
    let receipt = await readCodexReceipt(job.id, deviceId, payload),
        result = receipt?.result;
    let diagnostic: ICodexDiagnostic | undefined;
    const observeStage = (stage: TCodexDiagnosticStage) => {
        diagnostic = { schemaVersion: 1, ...diagnostic, stage };
    };
    const finish = async (value: DeviceCodexResult) => {
        const observed = sanitizeCodexDiagnostic(diagnostic ?? receipt?.diagnostic);
        const completed: ICodexReceipt = {
            schemaVersion: 1,
            jobId: job.id,
            lease: job.lease,
            deviceId,
            callId: payload.callId,
            payloadHash: hash(JSON.stringify(payload)),
            state: 'completed',
            result: value,
            ...(observed ? { diagnostic: observed } : {}),
        };
        try {
            await writeCodexReceipt(completed, receipt);
        } catch {
            throw unavailable();
        }
        receipt = completed;
        return {
            ...codexCompletionSummary(value),
            message:
                'response' in value
                    ? 'Ответ Codex получен.'
                    : 'Запрос Codex не завершён; повторная отправка не выполнялась.',
        };
    };
    if (result) return { ...codexCompletionSummary(result), message: 'Сохранённый результат Codex доставлен.' };
    if (receipt) return finish(failed(payload.callId, 'unknown-after-send'));
    const controller = new AbortController(),
        deadline = Date.parse(payload.deadlineAt) - Date.now();
    const timer = setTimeout(() => controller.abort(new Error('deadline')), Math.max(0, deadline));
    let poll: ReturnType<typeof setInterval> | undefined,
        pollPending = false,
        dispatched = false,
        denied = false;
    let checkIdentity: () => Promise<void> = async () => {};
    const check = async () => {
        controller.signal.throwIfAborted();
        try {
            await checkIdentity();
            await authorize();
            controller.signal.throwIfAborted();
            await checkIdentity();
        } catch (error) {
            denied = true;
            throw error;
        }
    };
    try {
        observeStage('preflight');
        if (deadline <= 0) throw new Error('deadline');
        checkIdentity = await localContext(deviceId, payload);
        await check();
        const context = normalizeDeviceCodexContext(await deps.context(job));
        if (
            context.callId !== payload.callId ||
            context.deadlineAt !== payload.deadlineAt ||
            !isDeepStrictEqual(context.source, payload.source)
        )
            throw new Error('Контекст Codex изменился.');
        const checkSource = () =>
            deps.checkLocal
                ? deps.checkLocal(context)
                : assertCodexModelSource(context, deviceId, check, async () => {
                      controller.signal.throwIfAborted();
                      await checkIdentity();
                  });
        await check();
        await checkSource();
        await check();
        const body = requestBody(context);
        observeStage('runtime-preparation');
        await deps.prepare?.(context, check);
        observeStage('transport-loading');
        await check();
        poll = setInterval(() => {
            if (pollPending) return;
            pollPending = true;
            void checkSource()
                .then(check)
                .catch(() => controller.abort(new Error('authorization')))
                .finally(() => {
                    pollPending = false;
                });
        }, deps.pollMs ?? 2000);
        const transport = await deps.transport(context.connectorPackage, check, async (input, init) => {
            if (dispatched || receipt) throw new Error('Повторная отправка Codex запрещена.');
            if (String(input) !== 'https://chatgpt.com/backend-api/codex/responses' || init?.method !== 'POST')
                throw new Error('Адрес запроса Codex не подтверждён.');
            await check();
            await checkSource();
            await check();
            const started: ICodexReceipt = {
                schemaVersion: 1,
                jobId: job.id,
                lease: job.lease,
                deviceId,
                callId: payload.callId,
                payloadHash: hash(JSON.stringify(payload)),
                state: 'started',
            };
            observeStage('dispatch-admission');
            await writeCodexReceipt(started, undefined);
            receipt = started;
            const admission = await deps.dispatch(job, payload.callId);
            if (!admission || typeof admission !== 'object' || (admission as { ok?: unknown }).ok !== true)
                throw new Error('Отправка Codex не разрешена.');
            await check();
            dispatched = true;
            observeStage('outbound-fetch');
            const response = await fetch(input, { ...init, signal: controller.signal });
            diagnostic = { schemaVersion: 1, stage: 'response-headers', ...observeCodexHttp(response) };
            return response;
        });
        await check();
        observeStage('transport-call');
        const response = await transport('https://chatgpt.com/backend-api/codex/responses', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        observeStage('response-validation');
        result = await readCodexResponse(response, context.model, payload.callId, controller.signal);
        observeStage('completed');
        await check();
    } catch (error) {
        // A complete response remains private evidence; the server decides whether a late ACK may apply it.
        const observed = sanitizeCodexDiagnostic(diagnostic);
        if (error instanceof CodexResponseFailure && observed?.stage === 'response-validation')
            diagnostic = { ...observed, reason: error.reason };
        const preparationCode =
            observed?.stage === 'runtime-preparation' && error instanceof RuntimeArtifactCapacityError
                ? error.code
                : undefined;
        if (!result)
            result = failed(
                payload.callId,
                receipt
                    ? 'unknown-after-send'
                    : Date.now() >= Date.parse(payload.deadlineAt)
                      ? 'deadline'
                      : denied || controller.signal.aborted
                        ? 'authorization'
                        : (preparationCode ?? 'unavailable'),
            );
    } finally {
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        controller.abort();
    }
    return finish(result!);
}
