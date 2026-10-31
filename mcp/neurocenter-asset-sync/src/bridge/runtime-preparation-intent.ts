import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicText, syncDirectory } from './atomic-file.js';
import { pendingCompletions, saveCompletion, type Completion } from './completions.js';
import { readBoundedUtf8 } from './read-bounded.js';
import { readState, stateDir, type Credentials } from './state.js';
import { sortedRefs, type InstallSet } from './install-set.js';
import type { Package } from './package.js';
import { RuntimeArtifactCapacityError } from '../features/runtime-artifacts/capacity-error.js';

interface Intent {
    schemaVersion: 1;
    pid: number;
    completion: Completion;
}
interface PreparationJob {
    id: string;
    lease: string;
    kind: string;
    project_id?: string;
    payload: {
        package?: Package;
        installSet?: InstallSet;
        bindingId?: string;
        changePlanId?: string;
        expectedChangeDigest?: string;
    };
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const text = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 500;
const directory = () => path.join(stateDir(), 'runtime-preparations');
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
};
function validate(item: Intent): void {
    const c = item?.completion,
        r = c?.result;
    if (
        !item ||
        Object.keys(item).sort().join(',') !== 'completion,pid,schemaVersion' ||
        item.schemaVersion !== 1 ||
        !Number.isSafeInteger(item.pid) ||
        item.pid < 1 ||
        !c ||
        !uuid.test(c.id) ||
        !uuid.test(c.lease) ||
        !uuid.test(c.deviceId ?? '') ||
        c.state !== 'failed' ||
        typeof c.message !== 'string' ||
        c.message.length > 1500 ||
        !r ||
        r.unchanged !== true ||
        Object.keys(r).some(
            (key) =>
                ![
                    'projectId',
                    'assetId',
                    'version',
                    'manifest',
                    'bindingId',
                    'packages',
                    'unchanged',
                    'changePlanId',
                    'digest',
                ].includes(key),
        ) ||
        !text(r.projectId) ||
        !text(r.assetId) ||
        !Number.isSafeInteger(r.version) ||
        Number(r.version) < 1 ||
        !hash.test(String(r.manifest)) ||
        !hash.test(String(r.bindingId)) ||
        (r.changePlanId !== undefined && (!uuid.test(String(r.changePlanId)) || !hash.test(String(r.digest)))) ||
        (r.packages !== undefined &&
            (!Array.isArray(r.packages) ||
                r.packages.length > 20 ||
                r.packages.some(
                    (ref) =>
                        !ref ||
                        Object.keys(ref).sort().join(',') !== 'id,kind,manifest,version' ||
                        !text(ref.id) ||
                        !['skill', 'mcp', 'plugin'].includes(ref.kind) ||
                        !Number.isSafeInteger(ref.version) ||
                        ref.version < 1 ||
                        !hash.test(ref.manifest),
                )))
    ) {
        throw new Error('Повреждено подтверждение подготовки готового комплекта.');
    }
}
async function remove(file: string): Promise<void> {
    await fs.unlink(file);
    await syncDirectory(directory());
}

/** Исходная идентичность нужна для позднего отказа после перезапуска, без повторного выполнения. */
export function runtimePreparationCompletion(job: PreparationJob, deviceId: string): Completion {
    const pkg = job.payload.package;
    if (
        !pkg ||
        !['install', 'apply-local-change'].includes(job.kind) ||
        (job.kind === 'apply-local-change' &&
            (!uuid.test(job.payload.changePlanId ?? '') || !hash.test(job.payload.expectedChangeDigest ?? '')))
    ) {
        throw new Error('Неизвестная подготовка готового комплекта.');
    }
    const completion: Completion = {
        id: job.id,
        lease: job.lease,
        deviceId,
        state: 'failed',
        message: 'Подготовка готового комплекта прервана. Файлы проекта не изменены; повторите действие.',
        result: {
            projectId: job.project_id,
            assetId: pkg.plugin.id,
            version: pkg.plugin.version,
            manifest: job.payload.installSet?.manifest ?? pkg.manifest.sha256,
            bindingId: job.payload.bindingId,
            unchanged: true,
            ...(job.payload.installSet ? { packages: sortedRefs(job.payload.installSet.packages) } : {}),
            ...(job.kind === 'apply-local-change'
                ? { changePlanId: job.payload.changePlanId, digest: job.payload.expectedChangeDigest }
                : {}),
        },
    };
    validate({ schemaVersion: 1, pid: process.pid, completion });
    return completion;
}

/** Intent существует только до передачи управления файловой транзакции установки/repair. */
export async function withRuntimePreparationIntent(
    completion: Completion | undefined,
    prepare: () => Promise<void>,
): Promise<void> {
    if (!completion) {
        await prepare();
        return;
    }
    const intent: Intent = { schemaVersion: 1, pid: process.pid, completion };
    validate(intent);
    await fs.mkdir(directory(), { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory());
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог подготовки недоступен.');
    const file = path.join(directory(), completion.id + '.json');
    if (
        await fs.lstat(file).then(
            () => true,
            (error) => {
                if (error.code === 'ENOENT') return false;
                throw error;
            },
        )
    )
        throw new Error('Подготовка этого задания уже требует сверки.');
    await atomicText(file, JSON.stringify(intent), 0o600);
    try {
        await prepare();
    } catch (error) {
        let message = completion.message;
        // Public receipts explain only known local capacity codes, never the original error text.
        if (error instanceof RuntimeArtifactCapacityError) {
            if (error.code === 'runtime-cache-full')
                message =
                    'Недостаточно места в кэше готовых комплектов. Проверьте лимит и использование кэша в разделе «Мои компьютеры», затем повторите действие. Файлы проекта не изменены.';
            else if (error.code === 'disk-full')
                message =
                    'На диске недостаточно свободного места для готового комплекта. Освободите место и повторите действие. Файлы проекта не изменены.';
        }
        await saveCompletion({ ...completion, message });
        await remove(file);
        throw error;
    }
    await remove(file);
}

/** Восстановленные файловые квитанции имеют приоритет; отправляется только отказ до записи проекта. */
export async function recoverRuntimePreparations(): Promise<void> {
    const credentials = await readState<Credentials>('credentials');
    if (!credentials) return;
    const info = await fs.lstat(directory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Каталог подготовки недоступен.');
    const files = await fs.readdir(directory()).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    for (const name of files.filter((name) => uuid.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))) {
        const file = path.join(directory(), name),
            intent = JSON.parse(await readBoundedUtf8(file, 16000)) as Intent;
        validate(intent);
        const completion = intent.completion;
        if (name !== completion.id + '.json') throw new Error('Идентичность подготовки не совпадает с именем файла.');
        if (completion.deviceId !== credentials.deviceId || alive(intent.pid)) continue;
        const previous = (await pendingCompletions()).find((item) => item.id === completion.id);
        if (previous && (previous.lease !== completion.lease || previous.deviceId !== completion.deviceId))
            throw new Error('Аренда подготовки не совпадает с сохранённым результатом.');
        if (!previous) await saveCompletion(completion);
        await remove(file);
    }
}
