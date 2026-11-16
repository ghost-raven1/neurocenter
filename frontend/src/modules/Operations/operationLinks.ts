/** Единый формат ссылок на операции: /operations?operation=<id>[&return=<исходный раздел>]. */

/** Проекция задания моста в журнал операций (operation_id = 'bridge-' + id задания). */
export function bridgeJobOperationId(jobId: string): string {
    return 'bridge-' + jobId;
}

/** Только относительные пути приложения; protocol-relative и внешние URL отбрасываются. */
export function isApplicationPath(value: string | null | undefined): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 2048 &&
        value.startsWith('/') &&
        !value.startsWith('//')
    );
}

/** Ссылка на операцию с опциональным возвратом в исходный раздел. */
export function operationsDeepLink(operationId?: string, returnTo?: string): string {
    const params = new URLSearchParams();
    if (operationId) params.set('operation', operationId);
    if (isApplicationPath(returnTo)) params.set('return', returnTo);
    return '/operations' + (params.size ? '?' + params.toString() : '');
}
