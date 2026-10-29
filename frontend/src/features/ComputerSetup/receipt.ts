import type {CliIntent, CliJob} from './model';
import {readCliJob, record} from './model';

/** Matches DeviceJobs' hash of the original role and all four fixed request fields. */
export async function cliRequestFingerprint(intent: CliIntent): Promise<string> {
    if (!globalThis.crypto?.subtle) throw Error('Браузер не может проверить исходную отправку. Откройте сайт по HTTPS или через localhost.');
    const input = JSON.stringify({role: intent.role, request: Object.entries(intent.request).sort(([a], [b]) => a.localeCompare(b))});
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A list result alone cannot settle an unknown POST or bind it to a saved request. */
export async function readCliReceipt(value: unknown, intent: CliIntent): Promise<CliJob> {
    if (!record(value) || value.requestKey !== intent.request.requestKey || value.requestFingerprint !== await cliRequestFingerprint(intent)) {
        throw Error('Квитанция не подтверждает исходный ключ, роль и запрос. Новая проверка приостановлена.');
    }
    return readCliJob(value.job, intent.request.deviceId, intent.jobId);
}
