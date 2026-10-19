import { jobMinimumLevel } from './device-job-access';

const RETRYABLE_KINDS = ['choose-root', 'install', 'uninstall', 'inspect-installation', 'restore-rag', 'sync-rag'];

/** Повторяем только задания, чьи исходные параметры проверяются обычным созданием очереди. */
export function deviceJobRetryPolicy(kind: string) {
    return { kind, retrySupported: RETRYABLE_KINDS.includes(kind), minimumLevel: jobMinimumLevel(kind) };
}
