import type { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { pipeline } from 'node:stream/promises';

/** Копия передаётся с backpressure; отмена браузера закрывает только соответствующее чтение каталога. */
export async function forwardBackupDownload(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    if (req.aborted || res.destroyed) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
        const response = await http.request({
            url,
            method: req.method,
            headers,
            params: req.query,
            responseType: 'stream',
            signal: controller.signal,
        });
        if (![200, 206].includes(response.status)) {
            response.data.destroy();
            res.status([401, 403, 404, 409, 416].includes(response.status) ? response.status : 502).json({
                message: 'Резервная копия недоступна. Обновите список и повторите скачивание.',
            });
            return;
        }
        const length = Number(response.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 0) {
            response.data.destroy();
            res.status(502).json({ message: 'Каталог вернул некорректный размер резервной копии.' });
            return;
        }
        res.status(response.status);
        res.setHeader('cache-control', 'no-store');
        for (const name of [
            'content-type',
            'content-disposition',
            'content-length',
            'accept-ranges',
            'content-range',
        ]) {
            const value = response.headers[name];
            if (typeof value === 'string') res.setHeader(name, value);
        }
        await pipeline(response.data, res);
    } catch {
        if (res.destroyed) return;
        if (!res.headersSent)
            res.status(502).json({ message: 'Скачивание резервной копии прервано. Повторите попытку.' });
        else res.destroy();
    } finally {
        res.off('close', abort);
    }
}
