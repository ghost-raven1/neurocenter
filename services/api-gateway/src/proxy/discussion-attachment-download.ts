import type { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { DISCUSSION_ATTACHMENT_MAX_BYTES } from '../../../shared/discussion-attachment-route.cjs';

/** Bounded private download; never send binary data through JSON response filtering. */
export async function forwardDiscussionAttachment(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    const controller = new AbortController(),
        abort = () => controller.abort(),
        closed = () => {
            if (!res.writableEnded) controller.abort();
        };
    req.on('aborted', abort);
    res.on('close', closed);
    try {
        if (req.aborted || res.destroyed) return;
        const upstream = await http.request({
            method: req.method === 'HEAD' ? 'HEAD' : 'GET',
            url,
            headers,
            responseType: 'arraybuffer',
            maxContentLength: DISCUSSION_ATTACHMENT_MAX_BYTES,
            timeout: 30000,
            maxRedirects: 0,
            validateStatus: () => true,
            signal: controller.signal,
        });
        if (req.aborted || res.destroyed) return;
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        if (upstream.status !== 200) {
            let message = 'Не удалось скачать файл. Повторите попытку.';
            try {
                const data = JSON.parse(Buffer.from(upstream.data).toString('utf8'));
                if (typeof data.message === 'string') message = data.message;
            } catch {
                /* Do not return upstream HTML or object bytes as an error. */
            }
            res.status(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502).json({ message });
            return;
        }
        const disposition = upstream.headers['content-disposition'];
        if (typeof disposition !== 'string' || !disposition.startsWith('attachment;')) {
            res.status(502).json({ message: 'Хранилище вернуло некорректный файл.' });
            return;
        }
        res.setHeader('Content-Disposition', disposition);
        res.setHeader('Content-Type', String(upstream.headers['content-type'] || 'application/octet-stream'));
        if (req.method === 'HEAD') {
            const length = Number(upstream.headers['content-length']);
            if (Number.isSafeInteger(length) && length > 0 && length <= DISCUSSION_ATTACHMENT_MAX_BYTES)
                res.setHeader('Content-Length', String(length));
            res.status(200).end();
            return;
        }
        const bytes = Buffer.from(upstream.data);
        res.status(200).send(bytes);
    } catch {
        if (!req.aborted && !res.destroyed)
            res.status(502).json({ message: 'Передача файла прервана. Повторите скачивание.' });
    } finally {
        req.off('aborted', abort);
        res.off('close', closed);
    }
}
