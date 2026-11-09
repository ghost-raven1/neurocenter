import axios from 'axios';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectRuntimeArchive, portablePath, type IRuntimeArtifact } from '../../../../shared/runtime-artifacts.cjs';
import {
    artifactQuotaBuildKey,
    artifactQuotaEvictKey,
    readProjectArtifactQuota,
    recordArtifactQuotaDelta,
    type IArtifactQuotaOptions,
} from './artifact-quota';
import { hostRuntimeTarget } from './host-target';
import type { IHostedMcpClaim } from './ticket';

const cacheRoot = (): string =>
    path.resolve(process.env.NEUROCENTER_MCP_HOST_DIR || path.join(os.tmpdir(), 'neurocenter-mcp-host'));
const inflight = new Map<string, Promise<string>>();

/**
 * Sidecar-мап комплекта (AD-D2): атрибуция к проекту и последнее доступ
 * (oldest-access LRU; atime/mtime ФС не используются — noatime/relatime ненадёжны).
 * Живёт внутри каталога комплекта: публикуется и удаляется одним rename/rm.
 */
interface IArtifactMeta {
    schemaVersion: 1;
    projectId: string;
    lastAccess: number;
    bytes: number;
}
const META_FILE = '.meta';

async function readArtifactMeta(root: string): Promise<IArtifactMeta | null> {
    try {
        const info = await fs.lstat(path.join(root, META_FILE));
        if (!info.isFile() || info.size > 8 * 1024) return null;
        const value: unknown = JSON.parse(await fs.readFile(path.join(root, META_FILE), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const meta = value as Partial<IArtifactMeta>;
        if (meta.schemaVersion !== 1) return null;
        if (typeof meta.projectId !== 'string' || meta.projectId.length < 1 || meta.projectId.length > 200) return null;
        if (typeof meta.lastAccess !== 'number' || !Number.isSafeInteger(meta.lastAccess) || meta.lastAccess < 1)
            return null;
        if (typeof meta.bytes !== 'number' || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) return null;
        return meta as IArtifactMeta;
    } catch {
        return null;
    }
}

/** Публикация мапа в свежем stage-каталоге: атомарна с самим комплектом (rename). */
async function writeArtifactMeta(root: string, meta: IArtifactMeta): Promise<void> {
    const handle = await fs.open(
        path.join(root, META_FILE),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o400,
    );
    try {
        await handle.writeFile(JSON.stringify(meta));
        await handle.sync();
    } finally {
        await handle.close();
    }
}

/** Touch при материализации (чтение кэша): обновляет lastAccess, tmp+rename; ошибка не фатальна. */
async function touchArtifactMeta(root: string): Promise<void> {
    try {
        const current = await readArtifactMeta(root);
        if (!current) return;
        const final = path.join(root, META_FILE),
            tmp = path.join(root, META_FILE + '.tmp');
        await fs.rm(tmp, { force: true });
        const handle = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT, 0o400);
        try {
            await handle.writeFile(JSON.stringify({ ...current, lastAccess: Date.now() }));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fs.rename(tmp, final);
    } catch {
        /* Кэш — оптимизация: ошибка touch не влияет на доступность комплекта. */
    }
}

/** Одна развёртка на SHA-256: скачивание с каталога по внутреннему токену, TAR без чужих флагов, копия только своих файлов. */
export async function materializeArtifact(
    claim: IHostedMcpClaim,
    catalogUrl: string,
    internalToken: string,
): Promise<string> {
    const finalRoot = path.join(cacheRoot(), 'artifacts', claim.artifactSha256);
    if (await ready(finalRoot, claim.entrypoint)) {
        await touchArtifactMeta(finalRoot);
        return finalRoot;
    }
    const pending = inflight.get(claim.artifactSha256);
    if (pending) {
        return pending;
    }
    const task = build(claim, finalRoot, catalogUrl, internalToken).finally(() =>
        inflight.delete(claim.artifactSha256),
    );
    inflight.set(claim.artifactSha256, task);
    return task;
}

async function build(
    claim: IHostedMcpClaim,
    finalRoot: string,
    catalogUrl: string,
    internalToken: string,
): Promise<string> {
    const stage = path.join(cacheRoot(), 'building', `.build-${claim.artifactSha256.slice(0, 12)}-${randomUUID()}`);
    const archive = path.join(stage, 'artifact.tar.gz');
    const unpack = path.join(stage, 'unpack');
    try {
        const existed = await fs.lstat(finalRoot).then((info) => info.isDirectory(), () => false);
        if (existed) await fs.rm(finalRoot, { recursive: true, force: true });
        await fs.mkdir(path.dirname(finalRoot), { recursive: true });
        await fs.mkdir(stage, { recursive: true, mode: 0o700 });
        await fs.mkdir(unpack, { recursive: true, mode: 0o700 });
        const response = await axios.get(
            `${catalogUrl.replace(/\/+$/, '')}/internal/mcp-host/artifact/${claim.artifactSha256}`,
            {
                responseType: 'stream',
                timeout: 120000,
                maxContentLength: claim.compressedBytes,
                maxBodyLength: claim.compressedBytes,
                headers: { 'x-neurocenter-internal': internalToken, 'accept-encoding': 'gzip' },
            },
        );
        if (response.status !== 200) {
            throw new Error('Комплект хоста недоступен в каталоге.');
        }
        let bytes = 0;
        const hash = createHash('sha256');
        const bounded = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > claim.compressedBytes) {
                    callback(new Error('Комплект хоста больше одобренной описи.'));
                    return;
                }
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(response.data, bounded, createWriteStream(archive, { mode: 0o600, flags: 'wx' }));
        if (bytes !== claim.compressedBytes || hash.digest('hex') !== claim.artifactSha256) {
            throw new Error('Размер или SHA комплекта хоста не совпадает с описью.');
        }
        const descriptor: IRuntimeArtifact = {
            target: hostRuntimeTarget(),
            sha256: claim.artifactSha256,
            compressedBytes: claim.compressedBytes,
            entrypoint: claim.entrypoint,
            executable: claim.executable,
            unpackedBytes: claim.unpackedBytes ?? Number(response.headers['x-neurocenter-unpacked-bytes']),
            filesCount: claim.filesCount ?? Number(response.headers['x-neurocenter-files-count']),
        };
        const entries = await inspectRuntimeArchive(archive, descriptor, { destination: unpack });
        const entry = await fs.lstat(path.join(unpack, claim.entrypoint)).catch(() => null);
        if (!entry || !entry.isFile()) {
            throw new Error('Точка входа отсутствует в развёрнутом комплекте.');
        }
        const handle = await fs.open(
            path.join(unpack, '.ready'),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o400,
        );
        try {
            await handle.writeFile(JSON.stringify({ schemaVersion: 2, sha256: claim.artifactSha256, entries }));
            await handle.sync();
        } finally {
            await handle.close();
        }
        const projectId = claim.session?.projectId;
        if (projectId) {
            await writeArtifactMeta(unpack, {
                schemaVersion: 1,
                projectId,
                lastAccess: Date.now(),
                bytes: descriptor.unpackedBytes,
            });
        }
        await fs.rename(unpack, finalRoot);
        await fs.rm(stage, { recursive: true, force: true });
        try {
            await enforceArtifactQuota({
                sha256: claim.artifactSha256,
                projectId,
                bytes: descriptor.unpackedBytes,
                existed,
                catalogUrl,
                internalToken,
            });
        } catch {
            /* Ошибка квоты не ломает материализацию: кэш — оптимизация, не источник истины. */
        }
        return finalRoot;
    } catch {
        await fs.rm(stage, { recursive: true, force: true });
        throw new Error('Комплект хоста недоступен. Повторите подключение.');
    }
}

/**
 * Per-project квота кэша (AD-D2): кредит нового комплекта, и если измерение
 * current проекта выше лимита — LRU-эвикция собственных `.ready`-комплектов
 * по oldest-access (sidecar-мап) до лимита. Затем global cap всего тома.
 */
async function enforceArtifactQuota(target: {
    sha256: string;
    projectId?: string;
    bytes: number;
    existed: boolean;
    catalogUrl: string;
    internalToken: string;
}): Promise<void> {
    if (!target.projectId) return;
    const options: IArtifactQuotaOptions = { catalogUrl: target.catalogUrl, internalToken: target.internalToken };
    if (target.bytes > 0 && !target.existed) {
        await recordArtifactQuotaDelta(
            target.projectId,
            target.bytes,
            artifactQuotaBuildKey(target.sha256, target.projectId),
            options,
        );
    }
    const quota = await readProjectArtifactQuota(target.projectId, options);
    if (quota && quota.limit > 0 && quota.used > quota.limit) {
        await evictProjectEntries(quota.limit, options, {
            projectId: target.projectId,
            excludeSha: target.sha256,
            used: quota.used,
        });
    }
    const cap = globalCacheCapBytes();
    if (cap > 0) {
        // Таргетный файл уже на томе (свежепостроен или кэш-хит) — учтём его в общем объёме.
        await evictGlobalCap(cap, options, { excludeSha: target.sha256, extraBytes: target.bytes });
    }
}

/** Global cap тома (защита от «100 проектов × unlimited»): 0 — выключен, иначе 10 ГБ. */
function globalCacheCapBytes(): number {
    const value = Number(process.env.NEUROCENTER_MCP_HOST_CACHE_MAX_BYTES);
    return Number.isSafeInteger(value) && value >= 0 ? value : 10 * 1024 * 1024 * 1024;
}

/** Комплекты с валидным sidecar-мапом: sha, корень, мап. */
async function listArtifactEntries(): Promise<Array<{ sha: string; root: string; meta: IArtifactMeta }>> {
    const directory = path.join(cacheRoot(), 'artifacts');
    let names: string[];
    try {
        names = await fs.readdir(directory);
    } catch {
        return [];
    }
    const entries: Array<{ sha: string; root: string; meta: IArtifactMeta }> = [];
    for (const name of names) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const root = path.join(directory, name);
        const meta = await readArtifactMeta(root);
        if (meta) entries.push({ sha: name, root, meta });
    }
    return entries;
}

/** LRU по oldest-access: только `.ready`-комплекты своего проекта, чей used > limit; чужие не трогает. */
async function evictProjectEntries(
    limitBytes: number,
    options: IArtifactQuotaOptions,
    scope: { projectId: string; excludeSha: string; used: number },
): Promise<void> {
    const entries = (await listArtifactEntries())
        .filter((entry) => entry.meta.projectId === scope.projectId && entry.sha !== scope.excludeSha)
        .sort((a, b) => a.meta.lastAccess - b.meta.lastAccess);
    let used = scope.used;
    for (const entry of entries) {
        if (used <= limitBytes || entry.meta.bytes <= 0) continue;
        await fs.rm(entry.root, { recursive: true, force: true });
        await recordArtifactQuotaDelta(
            scope.projectId,
            -entry.meta.bytes,
            artifactQuotaEvictKey(entry.sha, scope.projectId),
            options,
        );
        used -= entry.meta.bytes;
    }
}

/** Global cap: комплекты всех проектов по oldest-access; дебет идёт в мап-проект каждого. */
async function evictGlobalCap(
    capBytes: number,
    options: IArtifactQuotaOptions,
    scope: { excludeSha: string; extraBytes: number },
): Promise<void> {
    const entries = (await listArtifactEntries())
        .filter((entry) => entry.sha !== scope.excludeSha)
        .sort((a, b) => a.meta.lastAccess - b.meta.lastAccess);
    let total = scope.extraBytes + entries.reduce((sum, entry) => sum + entry.meta.bytes, 0);
    for (const entry of entries) {
        if (total <= capBytes || entry.meta.bytes <= 0) continue;
        await fs.rm(entry.root, { recursive: true, force: true });
        await recordArtifactQuotaDelta(
            entry.meta.projectId,
            -entry.meta.bytes,
            artifactQuotaEvictKey(entry.sha, entry.meta.projectId),
            options,
        );
        total -= entry.meta.bytes;
    }
}

async function ready(root: string, entrypoint: string): Promise<boolean> {
    try {
        const marker = await fs.lstat(path.join(root, '.ready'));
        const entry = await fs.lstat(path.join(root, entrypoint));
        if (!marker.isFile() || marker.size > 8 * 1024 * 1024 || !entry.isFile()) return false;
        const receipt = JSON.parse(await fs.readFile(path.join(root, '.ready'), 'utf8'));
        if (
            receipt.schemaVersion !== 2 ||
            receipt.sha256 !== path.basename(root) ||
            !Array.isArray(receipt.entries) ||
            !receipt.entries.length ||
            receipt.entries.length > 20000
        )
            return false;
        for (const file of receipt.entries) {
            if (!portablePath(file.path)) return false;
            const filename = path.join(root, file.path),
                info = await fs.lstat(filename);
            if (!info.isFile() || info.size !== file.size) return false;
            const hash = createHash('sha256');
            for await (const chunk of (await fs.open(filename, 'r')).createReadStream()) hash.update(chunk);
            if (hash.digest('hex') !== file.sha256) return false;
        }
        return receipt.entries.some((file: { path: string }) => file.path === entrypoint);
    } catch {
        return false;
    }
}
