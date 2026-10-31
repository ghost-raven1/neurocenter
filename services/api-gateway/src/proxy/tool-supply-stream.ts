import type { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** No archive buffer in Gateway; cancelled downloads close only their own upstream. */
export async function forwardToolSupply(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    return forwardToolDownload(http, url, headers, req, res, false);
}
/** A descriptor remains exact UTF-8 bytes across Gateway, without JSON reserialization. */
export async function forwardToolAssetDocument(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    return forwardToolDownload(http, url, headers, req, res, true);
}
async function forwardToolDownload(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
    document: boolean,
): Promise<void> {
    if (req.aborted || res.destroyed) return;
    const controller = new AbortController(),
        abort = () => controller.abort();
    req.on('aborted', abort);
    res.on('close', abort);
    const timer = setTimeout(abort, 5 * 60 * 1000);
    try {
        const response = await http.request({
            url,
            method: req.method,
            headers,
            responseType: 'stream',
            signal: controller.signal,
            timeout: 5 * 60 * 1000,
            maxContentLength: Infinity,
        });
        const head = req.method === 'HEAD';
        if (head && response.status === 204) {
            response.data.destroy();
            res.setHeader('Cache-Control', 'no-store');
            res.status(204).end();
            return;
        }
        if (response.status !== 200 || head) {
            response.data.destroy();
            res.status(
                [400, 401, 403, 404, 409, 413, 503, 504, 507].includes(response.status) ? response.status : 502,
            ).json({ message: 'Поставка недоступна. Проверьте права и состояние сборки.' });
            return;
        }
        const length = Number(response.headers['content-length']),
            disposition = response.headers['content-disposition'],
            contentType = response.headers['content-type'];
        if (
            !Number.isSafeInteger(length) ||
            length < 1 ||
            length > (document ? 16 * 1024 ** 2 : 4 * 1024 ** 3) ||
            (document
                ? typeof contentType !== 'string' || !/^application\/json(?:; charset=utf-8)?$/i.test(contentType)
                : contentType !== 'application/gzip' ||
                  typeof disposition !== 'string' ||
                  !/^attachment; filename="[a-zA-Z0-9][a-zA-Z0-9._+-]{0,300}\.tar\.gz"$/.test(disposition))
        ) {
            response.data.destroy();
            res.status(502).json({ message: 'Каталог вернул неподтверждённую поставку.' });
            return;
        }
        res.status(200);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', String(contentType));
        if (!document) res.setHeader('Content-Disposition', disposition);
        res.setHeader('Content-Length', String(length));
        let received = 0;
        await pipeline(
            response.data,
            new Transform({
                transform(chunk: Buffer, _encoding, done) {
                    received += chunk.length;
                    done(received > length ? new Error('Supply length exceeded') : null, chunk);
                },
                flush(done) {
                    done(received !== length ? new Error('Supply truncated') : null);
                },
            }),
            res,
            { signal: controller.signal },
        );
    } catch {
        if (!res.destroyed) {
            if (res.headersSent) res.destroy();
            else res.status(502).json({ message: 'Передача поставки прервана. Повторите скачивание.' });
        }
    } finally {
        clearTimeout(timer);
        req.off('aborted', abort);
        res.off('close', abort);
    }
}
