import fs from 'node:fs/promises';
import { safeTarget, type WorkspaceFileVerification } from './workspace.js';
import { withProjectFilesAt, commitChanges } from './installation-files.js';
import { inspectInstallationAt } from './installation-inspection.js';
import { assetKey } from './installation-receipt.js';
import { verify, type Package } from './package.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { LEDGER_PATH } from './installation-ledger.js';
import { InstallationPlan } from './installation-plan.js';
import { planInstall } from './installation-planner.js';
import { hash } from './state.js';
import { sortedRefs } from './install-set.js';
import { WorkspaceBindingError } from './workspace-binding-error.js';
import type { WorkspaceVerificationRelease } from './workspace-instance.model.js';
import { prepareMemoryOwnershipHandoffs } from '../features/project-learning-memory-sync/workspace-handoff.js';

async function hold(root: string): Promise<() => Promise<void>> {
    let ready!: () => void;
    let reject!: (error: unknown) => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve, fail) => {
        ready = resolve;
        reject = fail;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const operation = withProjectFilesAt(root, async () => {
        ready();
        await released;
    });
    operation.catch(reject);
    await acquired;
    return async () => {
        release();
        await operation;
    };
}

/** Все локальные квитанции должны иметь замороженное серверное происхождение; неизвестные не усыновляются. */
async function assertReceipts(root: string, packages: Package[]): Promise<void> {
    const directory = await safeTarget(root, '.opencode/neurocenter/receipts');
    const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    });
    const actual = names.filter((name) => name.endsWith('.json')).sort();
    const expected = packages.map((pkg) => assetKey(pkg) + '.json').sort();
    if (names.length > 1000 || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new WorkspaceBindingError(
            'installation-mismatch',
            'В папке есть неизвестные квитанции или отсутствует подтверждённая установка. Автоматическая привязка остановлена.',
        );
    }
    if (packages.length === 0) {
        try {
            const ledger = JSON.parse(await readBoundedUtf8(await safeTarget(root, LEDGER_PATH), 4 * 1024 * 1024)) as {
                schemaVersion?: number;
                roots?: object;
            };
            if (
                ledger.schemaVersion !== 1 ||
                !ledger.roots ||
                typeof ledger.roots !== 'object' ||
                Array.isArray(ledger.roots) ||
                Object.keys(ledger.roots).length > 0
            ) {
                throw new Error();
            }
        } catch (error) {
            if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
                throw error;
            }
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw new WorkspaceBindingError(
                    'installation-mismatch',
                    'Локальный реестр не подтверждён историей сервера.',
                );
            }
        }
    }
}

/** Удерживает прежние файловые locks до завершения identity commit; код инструментов не исполняет. */
export async function verifyWorkspaceInstallations(
    context: WorkspaceFileVerification,
    packages: Package[],
    authorize: () => Promise<unknown> = async () => undefined,
): Promise<WorkspaceVerificationRelease> {
    for (const pkg of packages) {
        verify(pkg);
    }
    if (
        packages.length > 20 ||
        packages.reduce((total, pkg) => total + pkg.files.length, 0) > 200 ||
        packages.reduce((total, pkg) => total + pkg.files.reduce((bytes, file) => bytes + file.size, 0), 0) >
            16 * 1024 * 1024
    ) {
        throw new Error('Превышен лимит сверки инструментов проекта.');
    }
    const releases: Array<() => Promise<void>> = [];
    try {
        const roots = [...new Set([context.targetRoot, ...(context.sourceRoot ? [context.sourceRoot] : [])])].sort();
        for (const root of roots) {
            releases.push(await hold(root));
        }
        await context.assertUnchanged();
        for (const root of roots) {
            await assertReceipts(root, packages);
            for (const pkg of packages) {
                const check = (configRoot: string) =>
                    inspectInstallationAt(root, context.projectId, context.previousBindingId ?? '0'.repeat(64), pkg, {
                        lockHeld: true,
                        configRoot,
                        assertIdentity: context.assertUnchanged,
                    });
                const matches = (result: Awaited<ReturnType<typeof check>>) =>
                    result.state === 'checked' &&
                    (result.status === 'synced' ||
                        (result.issues.length === 1 && result.issues[0] === 'runtime-path-unverified'));
                const previousRoot = context.previousConfigRoot ?? context.sourceRoot ?? root;
                const result = await check(previousRoot);
                // Повтор после прерывания принимает уже обновлённые собственные пути, но не произвольные команды.
                if (
                    !matches(result) &&
                    (root !== context.targetRoot || previousRoot === root || !matches(await check(root)))
                ) {
                    throw new WorkspaceBindingError(
                        'installation-mismatch',
                        'Локальные файлы или подключение отличаются от сохранённого серверного пакета. Сначала сохраните и проверьте изменения.',
                    );
                }
            }
        }
        const plan = new InstallationPlan(context.targetRoot);
        for (const pkg of packages) {
            await planInstall(plan, pkg);
        }
        await context.assertUnchanged();
        await plan.verifySnapshot();
        const changes = plan.changes();
        if (changes.length > 0) {
            await authorize();
            await context.assertUnchanged();
            // Файлы обновляются до публикации экземпляра; без job-result журнал не выдаст ранний успех привязки.
            await commitChanges(
                context.targetRoot,
                changes,
                {
                    action: 'install',
                    assetKey: hash('workspace:' + context.projectId).slice(0, 24),
                    manifest: hash(JSON.stringify(sortedRefs(packages))),
                },
                { verifySnapshot: () => plan.verifySnapshot() },
            );
        }
        const memoryOwnership = await prepareMemoryOwnershipHandoffs(context, packages);
        return Object.assign(
            async () => {
                for (const release of releases.reverse()) {
                    await release();
                }
            },
            { memoryOwnership },
        );
    } catch (error) {
        for (const release of releases.reverse()) {
            await release();
        }
        throw error;
    }
}
