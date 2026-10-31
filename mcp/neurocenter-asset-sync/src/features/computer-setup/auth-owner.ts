import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { findUserOpenCode, assertUserCliCurrent, userOpenCodeDirectories } from './executable.js';
import { observeOpenCodeCli } from './process.js';
import {
    beginLocalCliReceipt,
    cliProcessJournal,
    settleCliReceipt,
    retireLocalCliReceipt,
    readCliReceipt,
    CliCleanupError,
} from './receipts.js';
import { RoleMcpCleanupError } from '../system-role-mcp/owned-process.js';
import { contract as localProviders } from '../opencode-local-providers/contract.js';

export class OpenCodeAuthOwnerError extends Error {
    readonly code = 'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED';
    constructor() {
        super(
            'Запись auth.json поддерживается только обычным OpenCode ' +
                localProviders.OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION +
                '. Текущий CLI не подтверждён; локальная настройка доступна только для чтения.',
        );
    }
}
export interface OpenCodeAuthOwnerProof {
    assertCurrent(): Promise<void>;
}
const active = new Map<AbortController, { id: string; finished: Promise<void>; settled: boolean }>();
let stopping = false;
export const hasActiveOpenCodeAuthOwnerChecks = () => [...active.values()].some((value) => !value.settled);
export async function stopOpenCodeAuthOwnerChecks(): Promise<void> {
    stopping = true;
    for (const controller of active.keys()) controller.abort();
    await Promise.all([...active.values()].map((value) => value.finished));
}
export async function acknowledgeRecoveredOpenCodeAuthOwnerChecks(): Promise<void> {
    for (const [controller, value] of active) {
        if (!value.settled || (await readCliReceipt(value.id)))
            throw new CliCleanupError(new Error('Локальная проверка версии ещё не закрыта.'));
        active.delete(controller);
    }
}

/** Fresh actual-PATH fixed probe gates the pinned JSON-auth adapter; no version output leaves this local owner. */
export async function assertOpenCodeAuthOwner(
    deviceId: string,
    authorize: (signal?: AbortSignal) => Promise<unknown>,
    external?: AbortSignal,
): Promise<OpenCodeAuthOwnerProof> {
    if (stopping || active.size) throw new OpenCodeAuthOwnerError();
    const controller = new AbortController(),
        signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('Проверка версии превысила срок.')), 10000),
        id = randomUUID();
    let retired = false;
    const run = (async () => {
        let receipt = await beginLocalCliReceipt({ id, lease: randomUUID(), deviceId });
        try {
            const home = os.homedir(),
                environment = { ...process.env },
                search = environment.PATH ?? '';
            userOpenCodeDirectories(home, search);
            // A relative/empty PATH entry before a known command cannot safely borrow a project cwd.
            const parts = search.split(path.delimiter),
                relative = parts.findIndex((value) => !path.isAbsolute(value));
            const directories = [...new Set(relative < 0 ? parts : parts.slice(0, relative))];
            const bridgeRoots = [fileURLToPath(new URL('../../../', import.meta.url))];
            const executable = await findUserOpenCode(directories, bridgeRoots, signal, true);
            if (!executable) throw new OpenCodeAuthOwnerError();
            const current = async () => {
                if (stopping) throw new OpenCodeAuthOwnerError();
                signal.throwIfAborted();
                await authorize(signal);
                signal.throwIfAborted();
                if (os.homedir() !== home || process.env.PATH !== environment.PATH) throw new OpenCodeAuthOwnerError();
                await assertUserCliCurrent(executable, directories, bridgeRoots, signal, true);
            };
            const result = await observeOpenCodeCli(
                {
                    deviceId,
                    jobId: id,
                    home,
                    environment,
                    directories,
                    bridgeRoots,
                    pathOnly: true,
                    journal: () =>
                        cliProcessJournal(receipt, (next) => {
                            receipt = next;
                        }),
                },
                async () => {
                    await current();
                },
                signal,
            );
            if (
                result.status !== 'installed' ||
                result.version !== localProviders.OPENCODE_GLOBAL_PROVIDERS_AUTH_VERSION
            )
                throw new OpenCodeAuthOwnerError();
            await current();
            return { assertCurrent: current };
        } catch (error) {
            if (error instanceof CliCleanupError || error instanceof RoleMcpCleanupError) throw error;
            throw new OpenCodeAuthOwnerError();
        } finally {
            try {
                receipt = await settleCliReceipt(receipt);
                await retireLocalCliReceipt(receipt);
                retired = true;
            } catch (error) {
                // eslint-disable-next-line no-unsafe-finally -- Unconfirmed process cleanup invalidates the returned auth-owner lease and must remain recoverable.
                throw error instanceof CliCleanupError ? error : new CliCleanupError(error);
            }
        }
    })();
    const entry = {
        id,
        finished: run.then(
            () => {},
            (error) => {
                if (!retired) throw error;
            },
        ),
        settled: false,
    };
    active.set(controller, entry);
    void entry.finished.catch(() => {});
    try {
        return await run;
    } finally {
        clearTimeout(timer);
        entry.settled = true;
        if (retired) active.delete(controller);
    }
}
