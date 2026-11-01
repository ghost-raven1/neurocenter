import type { IUploadedSource, ISourceUpload } from './uploadInterfaces';

/** Build requests contain only a verified durable handle, never the binary File object. */
export function uploadedBuildSource(upload: ISourceUpload, entrypoint: string): IUploadedSource {
    const selected = entrypoint || upload.metadata?.entrypoint || '';
    if (upload.state !== 'READY' || !upload.metadata?.candidates.includes(selected))
        throw new Error('Завершите загрузку и выберите проверенный файл запуска.');
    return { type: 'upload', uploadId: upload.id, sha256: upload.sha256, bytes: upload.bytes, entrypoint: selected };
}
