import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { apiHub, jobContext, readState, type Credentials } from './state.js';
import { LIMITS, type RuntimeArtifact } from '../features/runtime-artifacts/model.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** Только одобренный архив площадки; native HTTP не использует уязвимый paused-parser fetch. */
export async function downloadJobRuntimeArtifact(artifact: RuntimeArtifact, timeoutMs = 120_000): Promise<IncomingMessage> {
    const job = jobContext.getStore(), credentials = await readState<Credentials>('credentials');
    if (!job || !uuid.test(job.id) || !uuid.test(job.lease) || !credentials || !uuid.test(credentials.deviceId)
        || job.deviceId !== credentials.deviceId || typeof credentials.token !== 'string' || !credentials.token
        || /[\r\n]/.test(credentials.token) || !/^[a-f0-9]{64}$/.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.compressedBytes) || artifact.compressedBytes <= 0 || artifact.compressedBytes > LIMITS.compressedBytes) {
        throw new Error('Артефакт доступен только в одобренном задании этого подключения.');
    }
    const url = new URL(`/api/device-channel/jobs/${job.id}/runtime/${artifact.sha256}`, apiHub());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Неподдерживаемый протокол площадки.');
    return new Promise((resolve, reject) => {
        let response: IncomingMessage | undefined;
        const request = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'GET', headers: { authorization: `Bearer ${credentials.token}`, 'accept-encoding': 'identity',
                'x-neurocenter-job-id': job.id, 'x-neurocenter-job-lease': job.lease },
        });
        const fail = () => {
            const error = new Error('Загрузка готового комплекта прервана или превысила время ожидания.');
            response?.destroy(error); request.destroy(error); reject(error);
        };
        const timer = setTimeout(fail, timeoutMs); timer.unref();
        request.setTimeout(timeoutMs, fail);
        request.on('error', () => { clearTimeout(timer); reject(new Error('Не удалось загрузить готовый комплект с площадки.')); });
        request.once('response', incoming => {
            response = incoming;
            // Ошибка может прийти до подключения pipeline; stream сохраняет её для потребителя.
            incoming.on('error', () => undefined);
            incoming.once('close', () => clearTimeout(timer));
            if (incoming.statusCode !== 200 || incoming.headers['content-length'] !== String(artifact.compressedBytes)) {
                incoming.destroy(); request.destroy(); clearTimeout(timer);
                reject(new Error('Готовый комплект недоступен или его размер не соответствует одобренному.')); return;
            }
            resolve(incoming);
        });
        request.end();
    });
}
