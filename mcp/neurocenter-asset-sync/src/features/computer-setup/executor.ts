import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCompletion } from '../../bridge/completions.js';
import { roleMcpLifecycleSupported } from '../system-role-mcp/owned-process.js';
import { normalizeOpenCodeCliPayload, OPENCODE_CLI_INSPECT_JOB } from './contract.js';
import { userOpenCodeDirectories } from './executable.js';
import { observeOpenCodeCli } from './process.js';
import {
    OPENCODE_CLI_INSTALL_JOB,
    normalizeOpenCodeInstallPayload,
    normalizeOpenCodeInstallResult,
    type OpenCodeInstallFailure,
} from './install-contract.js';
import { bundledOpenCodeInstallSource } from './install-supply.js';
import { installBundledOpenCode, CliInstallError } from './install.js';
import { runMethodCommand } from '../agent-method-workflow/process.js';
import { RoleMcpCleanupError } from '../system-role-mcp/owned-process.js';
import {
    stopOpenCodeAuthOwnerChecks,
    hasActiveOpenCodeAuthOwnerChecks,
    acknowledgeRecoveredOpenCodeAuthOwnerChecks,
} from './auth-owner.js';
import { markCliInstallPublication, markCliInstallStage, cliInstallProcessJournal } from './receipts.js';
import {
    beginCliReceipt,
    readCliReceipt,
    settleCliReceipt,
    cliProcessJournal,
    closeCliReceipt,
    completeCliReceipt,
    queueCliCompletion,
    recoverComputerSetupCompletions,
    CliCleanupError,
    cliFailureMessage,
    type CliReceipt,
} from './receipts.js';

interface CliJob {
    id: string;
    lease: string;
    kind: string;
    project_id?: string | null;
    payload: unknown;
}
const active = new Map<
    AbortController,
    { finished: Promise<void>; settled: boolean; closed: () => CliReceipt | undefined }
>();
let stopping = false;

/** The worker waits for owned processes and the private completion write before its stop can finish. */
export async function stopComputerSetupJobs(): Promise<void> {
    stopping = true;
    for (const controller of active.keys()) controller.abort(new Error('Мост останавливается.'));
    await Promise.all([...active.values()].map((item) => item.finished).concat(stopOpenCodeAuthOwnerChecks()));
}

/** The queue and installer share this cleanup fence; a live execution is never adopted by recovery. */
export async function recoverComputerSetupJobs(): Promise<void> {
    if (!roleMcpLifecycleSupported()) return;
    if (hasActiveOpenCodeAuthOwnerChecks())
        throw new CliCleanupError(new Error('Локальная проверка версии ещё выполняется.'));
    if ([...active.values()].some((item) => !item.settled))
        throw new CliCleanupError(new Error('Проверка OpenCode ещё выполняется.'));
    const expected = [...active.values()].flatMap((item) => {
        const receipt = item.closed();
        return receipt ? [receipt] : [];
    });
    await recoverComputerSetupCompletions(saveCompletion, expected);
    await acknowledgeRecoveredOpenCodeAuthOwnerChecks();
    for (const [controller, item] of active) if (item.settled) active.delete(controller);
}

/** Device-global observation never borrows a project folder, SDK probe or browser-supplied executable. */
export async function runComputerSetupJob(
    job: CliJob,
    deviceId: string,
    authorize: (signal?: AbortSignal) => Promise<unknown>,
): Promise<void> {
    const installing = job.kind === OPENCODE_CLI_INSTALL_JOB;
    if (
        stopping ||
        active.size ||
        !roleMcpLifecycleSupported() ||
        (!installing && job.kind !== OPENCODE_CLI_INSPECT_JOB) ||
        job.project_id != null
    )
        throw new Error('Проверка OpenCode недоступна.');
    const payload = installing
        ? normalizeOpenCodeInstallPayload(job.payload)
        : normalizeOpenCodeCliPayload(job.payload);
    if (payload.deviceId !== deviceId) throw new Error('Проверка OpenCode относится к другому компьютеру.');
    const controller = new AbortController();
    let closed: CliReceipt | undefined;
    const timer = setTimeout(
        () => controller.abort(Object.assign(new Error('Проверка OpenCode превысила срок.'), { name: 'TimeoutError' })),
        installing ? 90000 : 10000,
    );
    const run = (async () => {
        const identity = { id: job.id, lease: job.lease, deviceId },
            previous = await readCliReceipt(job.id);
        if (previous) {
            if (JSON.stringify(previous.job) !== JSON.stringify(identity))
                throw new CliCleanupError(new Error('Задание проверки OpenCode изменило владельца.'));
            if (previous.phase === 'closed') return;
            throw new CliCleanupError(new Error('Сначала восстановите прерванную проверку OpenCode.'));
        }
        let receipt: CliReceipt = await beginCliReceipt(
            identity,
            installing ? normalizeOpenCodeInstallPayload(payload) : undefined,
        );
        let completion: { state: 'succeeded' | 'failed'; message: string; result: Record<string, unknown> };
        try {
            const home = os.homedir(),
                environment = { ...process.env };
            const source = installing ? await bundledOpenCodeInstallSource() : undefined;
            const assertSource = async () => {
                if (
                    !source ||
                    JSON.stringify((await bundledOpenCodeInstallSource()).source) !==
                        JSON.stringify(normalizeOpenCodeInstallPayload(payload).source)
                )
                    throw new CliInstallError('source-changed');
            };
            const result =
                installing && source
                    ? await installBundledOpenCode({
                          payload: normalizeOpenCodeInstallPayload(payload),
                          jobId: job.id,
                          home,
                          directories: userOpenCodeDirectories(home, environment.PATH ?? ''),
                          pathDirectories: (environment.PATH ?? '')
                              .split(path.delimiter)
                              .filter((value) => path.isAbsolute(value)),
                          bridgeRoots: [fileURLToPath(new URL('../../../', import.meta.url))],
                          sourceFile: source.file,
                          signal: controller.signal,
                          authorize: async () => {
                              await authorize(controller.signal);
                          },
                          assertSource,
                          probe: async (file, current) => {
                              const journal = await cliInstallProcessJournal(receipt, (next) => {
                                  receipt = next;
                              });
                              const observed = await runMethodCommand(
                                  file,
                                  ['--version'],
                                  home,
                                  environment,
                                  current,
                                  controller.signal,
                                  journal,
                                  true,
                              );
                              if (observed.code !== 0 || observed.signal)
                                  throw new CliInstallError('verification-failed');
                              return observed.stdout.trim();
                          },
                          beforePublish: async () => {
                              receipt = await markCliInstallPublication(await settleCliReceipt(receipt));
                          },
                          published: async () => {},
                          stageOwned: async (stage) => {
                              receipt = await markCliInstallStage(await settleCliReceipt(receipt), stage);
                          },
                      })
                    : await observeOpenCodeCli(
                          {
                              deviceId,
                              jobId: job.id,
                              home,
                              environment,
                              directories: userOpenCodeDirectories(home, environment.PATH ?? ''),
                              bridgeRoots: [fileURLToPath(new URL('../../../', import.meta.url))],
                              journal: () =>
                                  cliProcessJournal(receipt, (next) => {
                                      receipt = next;
                                  }),
                          },
                          async (signal) => {
                              await authorize(signal);
                          },
                          controller.signal,
                      );
            completion = {
                state: ['installed', 'missing', 'unchanged'].includes(result.status) ? 'succeeded' : 'failed',
                result: { ...result },
                message: installing
                    ? 'Установка OpenCode завершена. Проверьте сохранённое состояние команды.'
                    : result.status === 'installed'
                      ? 'Пользовательский OpenCode найден.'
                      : result.status === 'missing'
                        ? 'Пользовательский OpenCode не найден.'
                        : result.status === 'timed-out'
                          ? 'Проверка OpenCode превысила срок. Повторите проверку.'
                          : 'Проверка OpenCode не завершена. Проверьте компьютер и повторите действие.',
            };
        } catch (error) {
            if (error instanceof CliCleanupError || error instanceof RoleMcpCleanupError)
                throw new CliCleanupError(error);
            const failure: OpenCodeInstallFailure =
                error instanceof CliInstallError
                    ? error.code
                    : controller.signal.aborted
                      ? 'cancelled'
                      : 'install-failed';
            const result = installing
                ? normalizeOpenCodeInstallResult({
                      ...normalizeOpenCodeInstallPayload(payload),
                      jobId: job.id,
                      checkedAt: new Date().toISOString(),
                      status: receipt.installation?.publicationStarted ? 'unknown' : 'failed',
                      installedVersion: null,
                      commandVersion: null,
                      commandReady: false,
                      nextAction: receipt.installation?.publicationStarted ? 'reconcile' : 'retry',
                      failure,
                  })
                : {};
            completion = { state: 'failed', result: { ...result }, message: cliFailureMessage };
        }
        receipt = await settleCliReceipt(receipt);
        await closeCliReceipt(receipt);
        receipt = await completeCliReceipt(receipt, { ...identity, ...completion });
        closed = structuredClone(receipt);
        await queueCliCompletion(receipt, saveCompletion);
    })();
    const entry = { finished: run, settled: false, closed: () => closed };
    active.set(controller, entry);
    let completed = false;
    try {
        await run;
        completed = true;
    } finally {
        entry.settled = true;
        clearTimeout(timer);
        if (completed) active.delete(controller);
    }
}
