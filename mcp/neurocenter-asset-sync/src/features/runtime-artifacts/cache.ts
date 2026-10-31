import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Package } from '../../bridge/package.js';
import { hash, stateDir } from '../../bridge/state.js';
import { atomicText } from '../../bridge/atomic-file.js';
import { enforcePrivateWindowsAcl } from '../local-configuration/private-store.js';
import {
    inspectRuntimeArchive,
    LIMITS,
    normalizeRuntimeArtifacts,
    portablePath,
    runtimeArtifactTarget,
    type RuntimeArtifact,
    type RuntimeArtifactEntry,
} from './model.js';
import { RuntimeArtifactCapacityError } from './capacity-error.js';

export interface RuntimeArtifactResolution {
    target: string;
    sha256: string;
    root: string;
    entrypoint: string;
    executable: boolean;
}
export interface ArtifactDownloadOptions {
    download: (artifact: RuntimeArtifact) => Promise<Readable>;
    cacheRoot?: string;
    repairCorrupt?: boolean;
    beforeCommit?: () => Promise<unknown>;
}
interface StagingOwner {
    schemaVersion: number;
    id: string;
    pid: number;
    replacement?: { sha256: string; quarantine: string };
}
interface CacheIndex {
    schemaVersion: 1;
    artifact: RuntimeArtifact;
    entries: RuntimeArtifactEntry[];
}
const INDEX = '.neurocenter-runtime-index.json';
const ARCHIVE = '.neurocenter-runtime-archive.tar.gz';
const cacheRoot = (): string => path.join(stateDir(), 'runtime-artifacts');
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
};

async function directory(root: string): Promise<void> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await enforcePrivateWindowsAcl(root, true);
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && info.mode & 0o077)) {
        throw new Error('Кэш готовых комплектов должен быть закрытой обычной папкой.');
    }
}

/** На POSIX публикация каталога подтверждается fsync до проектного commit. */
async function syncDirectory(folder: string): Promise<void> {
    if (process.platform === 'win32') {
        return;
    }
    const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function usage(root: string, limitBytes = LIMITS.cacheBytes): Promise<number> {
    let bytes = 0;
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
        const filename = path.join(root, item.name);
        const info = await fs.lstat(filename);
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) {
            throw new Error('Ссылки и специальные файлы в кэше запрещены.');
        }
        bytes += info.isDirectory() ? await usage(filename, limitBytes) : info.size;
        if (bytes > limitBytes) {
            throw new RuntimeArtifactCapacityError(
                'runtime-cache-full',
                'Кэш готовых комплектов превышает лимит ' +
                    limitBytes / 1024 ** 3 +
                    ' ГиБ. Настройте его в разделе «Мои компьютеры».',
            );
        }
    }
    return bytes;
}

async function lock(root: string): Promise<() => Promise<void>> {
    const filename = path.join(root, '.lock');
    const id = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await fs.open(filename, 'wx', 0o600);
            try {
                await handle.writeFile(JSON.stringify({ id, pid: process.pid }));
                await handle.sync();
            } finally {
                await handle.close();
            }
            return async () => {
                const raw = await fs.readFile(filename, 'utf8');
                if (raw === JSON.stringify({ id, pid: process.pid })) {
                    await fs.unlink(filename);
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
                throw error;
            }
            const info = await fs.lstat(filename);
            if (!info.isFile() || info.nlink !== 1 || info.size > 256) {
                throw new Error('Повреждена блокировка кэша.');
            }
            const raw = await fs.readFile(filename, 'utf8');
            let owner: { id: string; pid: number };
            try {
                owner = JSON.parse(raw) as typeof owner;
            } catch {
                throw new Error('Повреждена блокировка кэша.');
            }
            if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-f0-9-]{36}$/.test(owner.id)) {
                throw new Error('Повреждена блокировка кэша.');
            }
            if (alive(owner.pid)) {
                throw new Error('Другой процесс готовит комплект. Дождитесь завершения и повторите.');
            }
            if ((await fs.readFile(filename, 'utf8')) !== raw) {
                throw new Error('Владелец кэша изменился.');
            }
            await fs.unlink(filename);
        }
    }
    throw new Error('Не удалось заблокировать кэш готовых комплектов.');
}

/** Настройка бюджета и загрузка используют одну межпроцессную блокировку. */
export async function withRuntimeCacheLock<T>(action: (root: string) => Promise<T>, root = cacheRoot()): Promise<T> {
    await directory(root);
    const unlock = await lock(root);
    try {
        return await action(root);
    } finally {
        await unlock();
    }
}

/** Диагностика показывает занятый объём и при превышении текущего бюджета. */
export const measureRuntimeCache = (root: string): Promise<number> => usage(root, Number.MAX_SAFE_INTEGER);

/** После аварии удаляются только собственные staging с доказанно завершившимся PID. */
async function recoverStaging(root: string): Promise<void> {
    for (const name of await fs.readdir(root)) {
        if (!/^\.[a-f0-9-]{36}\.partial$/.test(name)) {
            continue;
        }
        const stage = path.join(root, name);
        const info = await fs.lstat(stage);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('Небезопасный незавершённый каталог кэша.');
        }
        const ownerFile = path.join(stage, '.owner.json');
        const ownerHandle = await fs.open(ownerFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let raw: string;
        try {
            const stat = await ownerHandle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) {
                throw new Error('Повреждён владелец незавершённой загрузки.');
            }
            raw = await ownerHandle.readFile('utf8');
        } finally {
            await ownerHandle.close();
        }
        const owner = JSON.parse(raw) as StagingOwner;
        if (
            owner.schemaVersion !== 1 ||
            name !== '.' + owner.id + '.partial' ||
            !Number.isSafeInteger(owner.pid) ||
            owner.pid < 1
        ) {
            throw new Error('Не подтверждён владелец незавершённой загрузки.');
        }
        if (alive(owner.pid)) {
            continue;
        }
        await usage(stage);
        if ((await fs.readFile(ownerFile, 'utf8')) !== raw) {
            throw new Error('Владелец незавершённой загрузки изменился.');
        }
        if (owner.replacement) {
            const replacement = owner.replacement;
            if (
                !/^[a-f0-9]{64}$/.test(replacement.sha256) ||
                replacement.quarantine !== `.quarantine-${replacement.sha256}-${owner.id}`
            ) {
                throw new Error('Повреждён журнал замены кэша.');
            }
            const target = path.join(root, replacement.sha256);
            const quarantine = path.join(root, replacement.quarantine);
            const targetExists = await fs.lstat(target).then(
                () => true,
                (error) => {
                    if (error.code === 'ENOENT') {
                        return false;
                    }
                    throw error;
                },
            );
            const previous = await fs.lstat(quarantine).catch((error) => {
                if (error.code === 'ENOENT') {
                    return undefined;
                }
                throw error;
            });
            if (!targetExists && previous) {
                if (!previous.isDirectory() || previous.isSymbolicLink()) {
                    throw new Error('Карантин кэша небезопасен.');
                }
                await fs.rename(quarantine, target);
                await syncDirectory(root);
            }
        }
        await fs.rm(stage, { recursive: true, force: false });
    }
}

function selected(pkg: Package): RuntimeArtifact | undefined {
    const artifacts = normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts);
    if (!artifacts.length) {
        return undefined;
    }
    const descriptor = artifacts.find((item) => item.target === runtimeArtifactTarget());
    if (!descriptor) {
        throw new Error(
            'Готового комплекта для этой ОС, архитектуры и libc нет. Выберите поддерживаемую платформу или обратитесь к администратору.',
        );
    }
    return descriptor;
}

async function verified(
    root: string,
    artifact: RuntimeArtifact,
    folder = path.join(root, artifact.sha256),
): Promise<RuntimeArtifactResolution> {
    const info = await fs.lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Кэш готового комплекта повреждён.');
    }
    const handle = await fs.open(
        path.join(folder, INDEX),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let index: CacheIndex;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 ** 2) {
            throw new Error('Повреждена опись готового комплекта.');
        }
        index = JSON.parse(await handle.readFile('utf8')) as CacheIndex;
    } finally {
        await handle.close();
    }
    if (
        index.schemaVersion !== 1 ||
        hash(
            JSON.stringify([
                index.artifact?.sha256,
                index.artifact?.compressedBytes,
                index.artifact?.unpackedBytes,
                index.artifact?.filesCount,
            ]),
        ) !==
            hash(
                JSON.stringify([
                    artifact.sha256,
                    artifact.compressedBytes,
                    artifact.unpackedBytes,
                    artifact.filesCount,
                ]),
            ) ||
        !Array.isArray(index.entries) ||
        index.entries.length !== artifact.filesCount
    ) {
        throw new Error('Кэш не соответствует одобренному комплекту.');
    }
    // SHA одобренного архива проверяется заново: подмена самой описи не скрывает правку файлов.
    const verifiedEntries = await inspectRuntimeArchive(path.join(folder, ARCHIVE), artifact);
    if (JSON.stringify(index.entries) !== JSON.stringify(verifiedEntries)) {
        throw new Error('Опись готового комплекта изменена.');
    }
    const expected = new Map<string, RuntimeArtifactEntry>();
    let total = 0;
    for (const entry of index.entries) {
        if (
            !portablePath(entry.path) ||
            expected.has(entry.path) ||
            [INDEX, ARCHIVE].includes(entry.path) ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0 ||
            !/^[a-f0-9]{64}$/.test(entry.sha256) ||
            typeof entry.executable !== 'boolean'
        ) {
            throw new Error('Повреждена опись готового комплекта.');
        }
        expected.set(entry.path, entry);
        total += entry.size;
    }
    if (total !== artifact.unpackedBytes) {
        throw new Error('Размер кэша не соответствует одобренному комплекту.');
    }
    let found = 0;
    async function walk(directoryPath: string, prefix = ''): Promise<void> {
        for (const name of await fs.readdir(directoryPath)) {
            const relative = prefix + name;
            if (!prefix && [INDEX, ARCHIVE].includes(name)) {
                continue;
            }
            const full = path.join(directoryPath, name);
            const stat = await fs.lstat(full);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
                throw new Error('Ссылка в готовом комплекте запрещена.');
            }
            if (stat.isDirectory()) {
                await walk(full, relative + '/');
                continue;
            }
            const entry = expected.get(relative);
            if (
                !entry ||
                stat.size !== entry.size ||
                (process.platform !== 'win32' && !!(stat.mode & 0o111) !== entry.executable)
            ) {
                throw new Error('Файлы готового комплекта изменены.');
            }
            const file = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const before = await file.stat();
                const digest = createHash('sha256');
                let readBytes = 0;
                for await (const chunk of file.createReadStream({ autoClose: false })) {
                    readBytes += chunk.length;
                    if (readBytes > entry.size) {
                        throw new Error('Файл готового комплекта изменился во время чтения.');
                    }
                    digest.update(chunk);
                }
                const after = await file.stat();
                if (
                    digest.digest('hex') !== entry.sha256 ||
                    before.ino !== after.ino ||
                    before.size !== after.size ||
                    before.mtimeMs !== after.mtimeMs
                ) {
                    throw new Error('Файлы готового комплекта изменены.');
                }
            } finally {
                await file.close();
            }
            found++;
        }
    }
    await walk(folder);
    if (found !== artifact.filesCount || !expected.has(artifact.entrypoint)) {
        throw new Error('Файлы готового комплекта отсутствуют.');
    }
    return {
        target: artifact.target,
        sha256: artifact.sha256,
        root: folder,
        entrypoint: path.join(folder, artifact.entrypoint),
        executable: artifact.executable ?? false,
    };
}

/** Целевой объём кэша мягкий; физическое место проверяется до сети, прежний комплект не удаляется. */
export async function ensureRuntimeArtifact(
    pkg: Package,
    options: ArtifactDownloadOptions,
): Promise<RuntimeArtifactResolution | undefined> {
    const artifact = selected(pkg);
    if (!artifact) {
        return undefined;
    }
    const root = options.cacheRoot ?? cacheRoot();
    await directory(root);
    const unlock = await lock(root);
    const stageId = randomUUID();
    const stage = path.join(root, '.' + stageId + '.partial');
    try {
        await recoverStaging(root);
        let corrupt = false;
        let exists = true;
        try {
            await fs.lstat(path.join(root, artifact.sha256));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
            exists = false;
        }
        if (exists) {
            try {
                return await verified(root, artifact);
            } catch (error) {
                if (!options.repairCorrupt) {
                    throw error;
                }
                const previous = await fs.lstat(path.join(root, artifact.sha256));
                if (!previous.isDirectory() || previous.isSymbolicLink()) {
                    throw error;
                }
                corrupt = true;
            }
        }
        await measureRuntimeCache(root);
        const required = artifact.compressedBytes + artifact.unpackedBytes + artifact.filesCount * 400 + 4096;
        const disk = await fs.statfs(root, { bigint: true });
        if (disk.bavail * disk.bsize < BigInt(required + 128 * 1024 ** 2)) {
            throw new RuntimeArtifactCapacityError(
                'disk-full',
                'На диске недостаточно свободного места для готового комплекта. Прежняя установка сохранена.',
            );
        }
        await fs.mkdir(stage, { mode: 0o700 });
        const ownerHandle = await fs.open(path.join(stage, '.owner.json'), 'wx', 0o600);
        try {
            await ownerHandle.writeFile(JSON.stringify({ schemaVersion: 1, id: stageId, pid: process.pid }));
            await ownerHandle.sync();
        } finally {
            await ownerHandle.close();
        }
        const archive = path.join(stage, 'artifact.tar.gz');
        const output = await fs.open(archive, 'wx', 0o600);
        try {
            let bytes = 0;
            const digest = createHash('sha256');
            await pipeline(
                await options.download(artifact),
                new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        bytes += chunk.length;
                        if (bytes > artifact.compressedBytes) {
                            callback(new Error('Архив превышает одобренный размер.'));
                            return;
                        }
                        digest.update(chunk);
                        callback(null, chunk);
                    },
                }),
                new Writable({
                    write(chunk: Buffer, _encoding, callback) {
                        output.writeFile(chunk).then(() => callback(), callback);
                    },
                }),
            );
            if (bytes !== artifact.compressedBytes || digest.digest('hex') !== artifact.sha256) {
                throw new Error('Архив повреждён или загрузка прервана. Прежняя установка сохранена.');
            }
            await output.sync();
        } finally {
            await output.close();
        }
        const payload = path.join(stage, 'payload');
        await fs.mkdir(payload, { mode: 0o700 });
        const entries = await inspectRuntimeArchive(archive, artifact, { destination: payload });
        if (
            entries.some(
                (entry) =>
                    [INDEX, ARCHIVE].includes(entry.path) ||
                    entry.path.startsWith(INDEX + '/') ||
                    entry.path.startsWith(ARCHIVE + '/'),
            )
        ) {
            throw new Error('Архив использует служебный путь кэша.');
        }
        await fs.rename(archive, path.join(payload, ARCHIVE));
        await fs.chmod(path.join(payload, ARCHIVE), 0o400);
        const indexHandle = await fs.open(path.join(payload, INDEX), 'wx', 0o400);
        try {
            await indexHandle.writeFile(JSON.stringify({ schemaVersion: 1, artifact, entries }));
            await indexHandle.sync();
        } finally {
            await indexHandle.close();
        }
        await syncDirectory(payload);
        await enforcePrivateWindowsAcl(payload, true);
        await verified(root, artifact, payload);
        await options.beforeCommit?.();
        const target = path.join(root, artifact.sha256);
        const quarantineName = `.quarantine-${artifact.sha256}-${stageId}`;
        const quarantine = path.join(root, quarantineName);
        let moved = false;
        let published = false;
        try {
            if (corrupt) {
                await atomicText(
                    path.join(stage, '.owner.json'),
                    JSON.stringify({
                        schemaVersion: 1,
                        id: stageId,
                        pid: process.pid,
                        replacement: { sha256: artifact.sha256, quarantine: quarantineName },
                    }),
                    0o600,
                );
                await fs.rename(target, quarantine);
                moved = true;
                await syncDirectory(root);
            }
            await fs.rename(payload, target);
            published = true;
            await syncDirectory(root);
            return await verified(root, artifact);
        } catch (error) {
            if (published) {
                await fs.rename(target, path.join(stage, 'failed-payload'));
            }
            if (moved) {
                await fs.rename(quarantine, target);
                await syncDirectory(root);
            }
            throw error;
        }
    } finally {
        await fs.rm(stage, { recursive: true, force: true });
        await unlock();
    }
}

/** Планировщик и launcher используют только уже загруженный полностью проверенный комплект. */
export async function resolvePreparedRuntimeArtifact(
    pkg: Package,
    root = cacheRoot(),
): Promise<RuntimeArtifactResolution | undefined> {
    const artifact = selected(pkg);
    return artifact ? verified(root, artifact) : undefined;
}
export { selected as selectedRuntimeArtifact };
