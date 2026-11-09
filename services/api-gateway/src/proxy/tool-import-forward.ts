import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import type { Request, Response } from 'express';
import { matchPolicy } from './route-policy';

/** A caller disconnect closes only its import request, so Catalog can stop before publication. */
export async function forwardToolImport(
    http: Pick<AxiosInstance, 'request'>,
    config: AxiosRequestConfig,
    req: Request,
    res: Response,
): Promise<AxiosResponse | undefined> {
    const abort = new AbortController(),
        connected = () => !abort.signal.aborted && !req.aborted && !res.destroyed && !res.writableEnded;
    const requestAborted = () => abort.abort(),
        responseClosed = () => {
            if (!res.writableEnded) abort.abort();
        };
    req.on('aborted', requestAborted);
    res.on('close', responseClosed);
    try {
        if (!connected()) return;
        // AD-6: деадлайн импорта (540 s) — из строки /api/tool-builds/imports route-политики.
        const response = await http.request({
            ...config,
            timeout: matchPolicy(req.method, req.path).timeoutMs,
            signal: abort.signal,
        });
        return connected() ? response : undefined;
    } catch (error) {
        if (connected()) throw error;
        return;
    } finally {
        req.off('aborted', requestAborted);
        res.off('close', responseClosed);
    }
}
