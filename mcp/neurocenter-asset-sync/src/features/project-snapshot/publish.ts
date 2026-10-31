import { authorizedFetch, jobContext } from '../../bridge/state.js';
import { saveCompletion } from '../../bridge/completions.js';
import { projectFolder } from '../../bridge/workspace.js';
import { captureProjectImage, type SnapshotCaptureInput } from './capture.js';
import { snapshotCanonicalJson } from './contract.js';

const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const message = 'Полный образ передан. Сервер проверяет снимок.';
/** Untrusted upstream bodies are bounded and never forwarded as raw provider/runtime diagnostics. */
async function receipt(response: Response, maximum = 32 * 1024 * 1024): Promise<unknown> {
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
            `Сервер не подтвердил передачу снимка (HTTP ${response.status}). Проверьте состояние публикации, доступ и соединение.`,
        );
    }
    if (!response.body) throw new Error('Сервер не вернул квитанцию снимка.');
    const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maximum) {
                await reader.cancel();
                throw new Error('Ответ снимка превышает допустимый размер.');
            }
            parts.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    const raw = Buffer.concat(parts),
        text = raw.toString('utf8');
    if (!Buffer.from(text).equals(raw)) throw new Error('Квитанция снимка повреждена.');
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('Квитанция снимка повреждена.');
    }
}
function uploaded(input: SnapshotCaptureInput, value: unknown, expected?: string) {
    if (
        !object(value) ||
        !keys(value, 'bytes,fileCount,manifestSha256,snapshotId,status,tableCount') ||
        value.snapshotId !== input.snapshotId
    )
        throw new Error('Сервер вернул другую публикацию снимка.');
    if (!['UPLOADED', 'VERIFYING', 'VERIFIED'].includes(String(value.status))) return undefined;
    if (
        !sha(value.manifestSha256) ||
        (expected !== undefined && value.manifestSha256 !== expected) ||
        !Number.isSafeInteger(value.bytes) ||
        Number(value.bytes) < 0 ||
        !Number.isSafeInteger(value.fileCount) ||
        Number(value.fileCount) < 1 ||
        !Number.isSafeInteger(value.tableCount) ||
        Number(value.tableCount) < 1
    )
        throw new Error('Сервер не подтвердил точную опись полного снимка.');
    return {
        projectId: input.projectId,
        bindingId: input.bindingId,
        snapshotId: input.snapshotId,
        manifestSha256: value.manifestSha256,
        status: 'UPLOADED' as const,
        bytes: Number(value.bytes),
        fileCount: Number(value.fileCount),
        tableCount: Number(value.tableCount),
    };
}

/** One leased intent publishes raw chunks. Accepted uploads are durably reported even after a lost ACK. */
export async function publishProjectSnapshot(
    input: SnapshotCaptureInput,
    authorize: () => Promise<unknown>,
    update: (percent: number, message: string) => Promise<unknown>,
) {
    const job = jobContext.getStore();
    if (!job?.id || !job.lease || !job.deviceId)
        throw new Error('Полный снимок требует задания с действующей привязкой устройства.');
    const route = `/api/projects/${encodeURIComponent(input.projectId)}/snapshot-uploads/${encodeURIComponent(input.snapshotId)}`;
    const status = () =>
        authorizedFetch(route + '/status', { signal: AbortSignal.timeout(120000) }).then((value) =>
            receipt(value, 4096),
        );
    const retain = async (result: NonNullable<ReturnType<typeof uploaded>>) => {
        try {
            await saveCompletion({ ...job, state: 'succeeded', message, result });
        } catch {
            throw Object.assign(
                new Error(
                    'Сервер принял полный снимок. Локальная квитанция не сохранена; состояние будет восстановлено сервером.',
                ),
                { localChangesCommitted: true },
            );
        }
        return result;
    };
    await authorize();
    const previous = uploaded(input, await status());
    if (previous) return retain(previous);
    const root = await projectFolder(input.projectId);
    await update(5, 'Проверяем все таблицы и файлы LanceDB.');
    const image = await captureProjectImage(root, input, authorize);
    try {
        await image.assertCurrent();
        const begin = await receipt(
            await authorizedFetch(route + '/manifest', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: snapshotCanonicalJson(image.manifest),
                signal: AbortSignal.timeout(120000),
            }),
        );
        if (
            !object(begin) ||
            !keys(begin, 'manifestSha256,missing') ||
            begin.manifestSha256 !== image.manifestSha256 ||
            !Array.isArray(begin.missing)
        )
            throw new Error('Сервер подтвердил другую опись снимка. Передача остановлена.');
        const missing: Array<{ sha256: string; size: number }> = [],
            seen = new Set<string>();
        let remaining = 0;
        for (const part of begin.missing) {
            if (
                !object(part) ||
                !keys(part, 'sha256,size') ||
                !sha(part.sha256) ||
                seen.has(part.sha256) ||
                !Number.isSafeInteger(part.size) ||
                image.chunks.get(part.sha256)?.size !== part.size
            )
                throw new Error('Сервер запросил блок вне подтверждённой описи.');
            missing.push({ sha256: part.sha256, size: Number(part.size) });
            seen.add(part.sha256);
            remaining += Number(part.size);
        }
        let done = 0;
        for (const part of missing) {
            await image.checkpoint();
            const bytes = await image.readChunk(part.sha256);
            await image.checkpoint();
            const saved = await receipt(
                await authorizedFetch(`${route}/blobs/${part.sha256}`, {
                    method: 'PUT',
                    headers: { 'content-type': 'application/octet-stream', 'content-length': String(part.size) },
                    body: bytes as unknown as RequestInit['body'],
                    signal: AbortSignal.timeout(150000),
                }),
                4096,
            );
            if (
                !object(saved) ||
                !keys(saved, 'bytes,sha256') ||
                saved.sha256 !== part.sha256 ||
                saved.bytes !== part.size
            )
                throw new Error('Сервер не подтвердил точный SHA и размер блока снимка.');
            await image.checkpoint();
            done += part.size;
            await update(
                remaining ? 10 + Math.floor((done * 85) / remaining) : 95,
                `Передано блоков снимка: ${done} из ${remaining} байт.`,
            );
        }
        await image.assertCurrent();
        await update(97, 'Полный образ передан. Передаём серверу на независимую проверку.');
        let complete: unknown;
        try {
            complete = await receipt(
                await authorizedFetch(route + '/complete', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ manifestSha256: image.manifestSha256 }),
                    signal: AbortSignal.timeout(120000),
                }),
                4096,
            );
            if (
                !object(complete) ||
                !keys(complete, 'snapshotId,status') ||
                complete.snapshotId !== input.snapshotId ||
                !['VERIFYING', 'VERIFIED'].includes(String(complete.status))
            )
                throw new Error('Сервер не подтвердил приём полного образа.');
        } catch {
            let accepted: ReturnType<typeof uploaded>;
            try {
                accepted = uploaded(input, await status(), image.manifestSha256);
            } catch {
                throw Object.assign(
                    new Error(
                        'Ответ о приёме снимка не получен. Сервер восстановит подтверждённое состояние публикации; повторное чтение источника не выполняется.',
                    ),
                    { localChangesCommitted: true },
                );
            }
            if (accepted) return await retain(accepted);
            throw Object.assign(
                new Error(
                    'Приём снимка ещё не подтверждён. Сервер восстановит окончательное состояние публикации после завершения запроса.',
                ),
                { localChangesCommitted: true },
            );
        }
        return await retain({
            projectId: input.projectId,
            bindingId: input.bindingId,
            snapshotId: input.snapshotId,
            manifestSha256: image.manifestSha256,
            status: 'UPLOADED',
            bytes: image.manifest.files.reduce((sum, file) => sum + file.size, 0),
            fileCount: image.manifest.files.length,
            tableCount: image.manifest.tables.length,
        });
    } finally {
        await image.close();
    }
}
