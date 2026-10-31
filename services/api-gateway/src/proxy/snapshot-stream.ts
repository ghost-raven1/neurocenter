import type { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { pipeline, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { SNAPSHOT_CHUNK_BYTES } from '../../../shared/project-snapshot.cjs';

/** A chunk is committed by the client only after its exact length and SHA have arrived. */
export async function forwardSnapshotChunk(
    http: AxiosInstance,
    url: string,
    headers: Record<string, string>,
    req: Request,
    res: Response,
): Promise<void> {
    const controller = new AbortController(),
        closed = () => {
            if (!res.writableEnded) controller.abort();
        };
    res.on('close', closed);
    const timer = setTimeout(() => controller.abort(), 120000);
    timer.unref();
    try {
        const upstream = await http.request({
            url,
            method: req.method,
            headers,
            responseType: 'stream',
            signal: controller.signal,
            timeout: 120000,
            maxRedirects: 0,
            validateStatus: () => true,
        });
        if (upstream.status !== 200) {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of upstream.data) {
                bytes += chunk.length;
                if (bytes > 65536) throw new Error('snapshot-error-limit');
                chunks.push(Buffer.from(chunk));
            }
            const text = Buffer.concat(chunks).toString('utf8');
            let data: unknown;
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: 'Не удалось получить блок снимка.' };
            }
            res.status(upstream.status).json(data);
            return;
        }
        const size = Number(upstream.headers['content-length']);
        if (!Number.isSafeInteger(size) || size < 1 || size > SNAPSHOT_CHUNK_BYTES) throw new Error('snapshot-size');
        res.status(200).set({
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(size),
            'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
            upstream.data.destroy();
            res.end();
            return;
        }
        let bytes = 0,
            tail: Buffer | undefined;
        const hash = createHash('sha256'),
            expected = url.slice(url.lastIndexOf('/') + 1);
        const check = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                bytes += chunk.length;
                if (bytes > size) {
                    done(new Error('snapshot-too-large'));
                    return;
                }
                hash.update(chunk);
                // Hold one byte until SHA succeeds: Content-Length must never look complete for corrupt input.
                if (chunk.length) {
                    if (tail) this.push(tail);
                    if (chunk.length > 1) this.push(chunk.subarray(0, -1));
                    tail = Buffer.from(chunk.subarray(-1));
                }
                done();
            },
            flush(done) {
                if (bytes !== size || hash.digest('hex') !== expected) {
                    done(new Error('snapshot-checksum'));
                    return;
                }
                done(null, tail);
            },
        });
        await promisify(pipeline)(upstream.data, check, res);
    } catch {
        if (res.headersSent) res.destroy();
        else if (!res.destroyed)
            res.status(502).json({ message: 'Передача блока снимка прервана. Повторите загрузку блока.' });
    } finally {
        clearTimeout(timer);
        controller.abort();
        res.off('close', closed);
    }
}
