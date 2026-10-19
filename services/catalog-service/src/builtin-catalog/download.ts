import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectRuntimeArchive } from '../../../shared/runtime-artifacts.cjs';
import type { IBuiltinArtifact } from './manifest';
import { reserveCapacity } from '../../../shared/capacity.cjs';

/** Проверенные неизменяемые файлы повторно используются, сетевой ответ ограничен точным размером. */
export async function downloadBuiltinArtifact(artifact: IBuiltinArtifact, directory: string, staging: string,
    request: typeof fetch = fetch): Promise<string> {
    const existing = path.join(directory, artifact.descriptor.sha256 + '.tar.gz');
    try { await inspectRuntimeArchive(existing, artifact.descriptor); return existing; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    const response = await request(artifact.url, { signal: AbortSignal.timeout(10 * 60_000), redirect: 'follow' });
    if (!response.ok || !response.body) { throw new Error(`Не удалось скачать готовый комплект (HTTP ${response.status}).`); }
    const length = response.headers.get('content-length');
    if (length !== null && length !== String(artifact.descriptor.compressedBytes)) {
        await response.body.cancel(); throw new Error('Размер ответа не совпадает с закреплённым комплектом.');
    }
    const filename = path.join(staging, artifact.descriptor.sha256 + '.tar.gz');
    const file = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const reader = response.body.getReader(), digest = createHash('sha256');
    let size = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) { break; }
            size += chunk.value.byteLength;
            if (size > artifact.descriptor.compressedBytes) { throw new Error('Загрузка превысила закреплённый размер комплекта.'); }
            digest.update(chunk.value); await file.writeFile(chunk.value);
        }
        if (size !== artifact.descriptor.compressedBytes || digest.digest('hex') !== artifact.descriptor.sha256) { throw new Error('SHA-256 или размер загруженного комплекта не совпадает.'); }
        await file.sync();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
    await inspectRuntimeArchive(filename, artifact.descriptor);
    return filename;
}

/** Предзагрузка не меняет БД и никогда не перезаписывает существующий SHA-файл. */
export async function cacheBuiltinArtifacts(artifacts: IBuiltinArtifact[], directory: string, request: typeof fetch = fetch): Promise<Map<string, string>> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Каталог готовых комплектов заменён ссылкой.'); }
    const staging = await fs.mkdtemp(path.join(directory, '.catalog-download-'));
    const cached = new Map<string, string>();
    try {
        for (const artifact of artifacts) {
            if (cached.has(artifact.descriptor.sha256)) { await inspectRuntimeArchive(cached.get(artifact.descriptor.sha256)!, artifact.descriptor); continue; }
            const existing = path.join(directory, artifact.descriptor.sha256 + '.tar.gz');
            try {
                await inspectRuntimeArchive(existing, artifact.descriptor);
                cached.set(artifact.descriptor.sha256, existing); continue;
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            const releaseCapacity = await reserveCapacity({ resource: 'runtime-artifacts', bytes: artifact.descriptor.compressedBytes, path: directory });
            try {
                const source = await downloadBuiltinArtifact(artifact, directory, staging, request);
                const target = path.join(directory, artifact.descriptor.sha256 + '.tar.gz');
                if (source !== target) {
                    await fs.chmod(source, 0o400);
                    try { await fs.link(source, target); }
                    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
                    await fs.unlink(source);
                    if (process.platform !== 'win32') {
                        const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                        try { await handle.sync(); } finally { await handle.close(); }
                    }
                    await inspectRuntimeArchive(target, artifact.descriptor);
                }
                cached.set(artifact.descriptor.sha256, target);
            } finally { releaseCapacity(); }
        }
        return cached;
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
