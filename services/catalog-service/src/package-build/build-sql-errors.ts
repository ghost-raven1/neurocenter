import { ServiceUnavailableException } from '@nestjs/common';

/** Keep an unconfirmed SQL outcome retryable without exposing database details to the caller. */
export async function withBuildSqlErrors<T>(work: () => Promise<T>): Promise<T> {
    try {
        return await work();
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['55P03', '57014'].includes(String(error.code))) {
            throw new ServiceUnavailableException(
                'Сервер не подтвердил результат запроса. Проверьте его состояние или повторите сохранённый запрос.',
                { cause: error, description: 'Service Unavailable' },
            );
        }
        throw error;
    }
}
