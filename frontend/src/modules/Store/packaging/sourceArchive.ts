import { packagingApi } from './api';
import type { PackagingInputFile, PackagingFilesResult } from './sourceFiles';

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

/** Сервер проверяет архив до сборки; браузер отправляет только один ограниченный по размеру файл. */
export async function readPackagingArchive(file: PackagingInputFile, signal?: AbortSignal): Promise<PackagingFilesResult> {
    if (!/\.(?:zip|tar|tar\.gz|tgz)$/i.test(file.name)) throw new Error('Выберите архив ZIP, TAR, TAR.GZ или TGZ.');
    if (!file.size || file.size > MAX_ARCHIVE_BYTES) throw new Error('Размер архива — от 1 байта до 8 МБ.');
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.length !== file.size) throw new Error('Размер архива изменился. Выберите файл заново.');
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
    return packagingApi.archive({ name: file.name, contentBase64: btoa(chunks.join('')) }, signal);
}
