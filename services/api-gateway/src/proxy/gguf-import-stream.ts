import type { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { forwardSourceUpload } from './source-upload-stream';
import { matchPolicy } from './route-policy';

/** The authenticated durable receipt owns limits even after the administrator changes policy. */
export async function forwardGgufImport(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    res.setHeader('Connection', 'close');
    res.setHeader('Cache-Control', 'no-store');
    // AD-6: бюджет квитанции и ответа на загрузку (1 MiB) — из строки route-политики.
    const policy = matchPolicy(req.method, req.path);
    try {
        const receipt = await http.get(url.replace(/\/content$/, ''), {
            headers,
            maxContentLength: policy.maxResponseBytes,
            maxRedirects: 0,
            validateStatus: () => true,
        });
        if (receipt.status !== 200) {
            res.status(receipt.status).json(receipt.data);
            return;
        }
        const { bytes, limits } = receipt.data || {};
        if (
            !Number.isSafeInteger(bytes) ||
            bytes < 1 ||
            !Number.isSafeInteger(limits?.maximumBytes) ||
            bytes > limits.maximumBytes ||
            !Number.isSafeInteger(limits?.uploadTimeoutMs) ||
            limits.uploadTimeoutMs < 1 ||
            limits.uploadTimeoutMs > 2147483647
        ) {
            res.status(502).json({ message: 'Каталог не подтвердил лимиты выбранного импорта.' });
            return;
        }
        // Динамические лимиты квитанции (bytes, uploadTimeoutMs) передаёт вызывающий;
        // бюджет ответа на загрузку — из route-политики.
        await forwardSourceUpload(http, url, headers, req, res, 'PUT', bytes, undefined, limits.uploadTimeoutMs);
    } catch {
        if (!res.destroyed && !res.headersSent)
            res.status(502).json({
                message: 'Не удалось проверить квитанцию GGUF. Повторите после восстановления каталога.',
            });
    }
}
