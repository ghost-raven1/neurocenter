import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException } from '@nestjs/common';
import type { PackageBuildRepository } from './package-build.repository';
import { validId } from './package-build.model';
import { stopBuildProcess } from './build-process';
import { mayRecoverBuildStage, forgetBuildCleanup, acknowledgeBuildCleanup } from './build-cleanup';

/** Internal control flow: cancelled work can never be reported as a new failure. */
export class BuildCancelledError extends Error {
    constructor() {
        super('Сборка отменена. Исходники и ранее опубликованные версии сохранены.');
    }
}

/** Each worker owns its cancellation and exact child; standby replicas are observed through SQL. */
export class BuildCancellation {
    readonly controller = new AbortController();
    private child?: ChildProcess;
    private checking = false;
    private readonly timer: ReturnType<typeof setInterval>;
    constructor(
        private readonly read: () => Promise<{ state: string }>,
        private readonly changed: () => void = () => {},
    ) {
        this.timer = setInterval(() => {
            if (this.checking || this.controller.signal.aborted) return;
            this.checking = true;
            void this.read()
                .then((row) => {
                    if (['CANCELLING', 'CANCELLED'].includes(row.state)) this.cancel();
                })
                .catch(() => this.abort(new Error('Не удалось подтвердить состояние сборки. Работа остановлена.')))
                .finally(() => {
                    this.checking = false;
                });
        }, 500);
        this.timer.unref();
    }
    cancel(): void {
        this.abort(new BuildCancelledError());
    }
    /** Lease loss/shutdown aborts provider waits and runtime checks without claiming user cancellation. */
    stop(reason: Error): void {
        this.abort(reason);
    }
    private abort(reason: Error): void {
        if (!this.controller.signal.aborted) {
            this.controller.abort(reason);
            this.changed();
        }
        if (this.child) stopBuildProcess(this.child);
    }
    observe(child: ChildProcess | undefined): void {
        this.child = child;
        if (child && this.controller.signal.aborted) stopBuildProcess(child);
    }
    assertActive(): void {
        this.controller.signal.throwIfAborted();
    }
    dispose(): void {
        clearInterval(this.timer);
        this.child = undefined;
    }
}

/** Only UUID stages recorded in this queue are cleaned; shared SHA archives are never touched. */
export async function cleanupBuildStages(
    repository: PackageBuildRepository,
    root: string,
    ownStopped = new Set<string>(),
): Promise<boolean> {
    let entries: import('node:fs').Dirent[];
    try {
        const info = await fs.lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new ConflictException('Каталог серверной сборки недоступен.');
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
        else throw error;
    }
    const ids = entries.filter((entry) => validId(entry.name)).map((entry) => entry.name);
    let pending = false;
    const candidates = [...(await repository.stagesToClean(ids)), ...(await repository.cancellationsWithoutStage(ids))];
    for (const row of candidates) {
        const own = row.execution_nonce && ownStopped.has(row.execution_nonce);
        if (!own && !(await mayRecoverBuildStage(root, row))) {
            if (row.state === 'CANCELLING') {
                pending = true;
                await repository.cancellationAwaitingOwner(row.id);
            }
            continue;
        }
        try {
            await fs.rm(path.join(root, row.id), { recursive: true, force: true });
        } catch (error) {
            if (row.state === 'CANCELLING') await repository.cancellationCleanupFailed(row.id);
            throw error;
        }
        if (row.state === 'CANCELLING') {
            if (own) await acknowledgeBuildCleanup(root, row);
            await repository.completeCancellation(row.id);
        }
        await forgetBuildCleanup(root, row);
        if (row.execution_nonce) ownStopped.delete(row.execution_nonce);
    }
    return pending;
}
