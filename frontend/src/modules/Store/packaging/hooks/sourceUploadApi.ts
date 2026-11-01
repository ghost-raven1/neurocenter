import base from '../../../../core/api/base';
import type { ISourceUpload, ISourceUploadIntent } from '../uploadInterfaces';
const route = '/api/tool-builds/uploads';
const control = { timeout: 15000 };
/** Raw File bodies are streamed by the browser; JSON remains a small control plane. */
export const sourceUploadApi = {
    create: (body: ISourceUploadIntent, signal?: AbortSignal) =>
        base.post<ISourceUpload>(route, body, { ...control, signal }).then((response) => response.data),
    lookup: (key: string, signal?: AbortSignal) =>
        base
            .get<ISourceUpload>(route + '/requests/' + encodeURIComponent(key), { ...control, signal })
            .then((response) => response.data),
    get: (id: string, signal?: AbortSignal) =>
        base
            .get<ISourceUpload>(route + '/' + encodeURIComponent(id), { ...control, signal })
            .then((response) => response.data),
    cancel: (key: string, signal?: AbortSignal) =>
        base
            .delete<ISourceUpload>(route + '/requests/' + encodeURIComponent(key), { ...control, signal })
            .then((response) => response.data),
    content: (id: string, file: File, signal: AbortSignal, onProgress: (percent: number) => void) =>
        base
            .put<ISourceUpload>(route + '/' + encodeURIComponent(id) + '/content', file, {
                timeout: 10 * 60 * 1000,
                signal,
                headers: { 'Content-Type': 'application/octet-stream' },
                onUploadProgress: (event) => onProgress(Math.min(99, Math.floor((event.loaded / file.size) * 100))),
            })
            .then((response) => response.data),
};
