import { isAxiosError } from 'axios';

/** Показывает понятное сообщение сервера, сохраняя русский текст для сетевых ошибок. */
export function errorMessage(error: unknown, fallback: string): string {
    if (isAxiosError(error)) {
        const message: unknown = error.response?.data?.message;
        return typeof message === 'string' && message.length > 0 && message !== 'Internal server error' ? message : fallback;
    }
    return error instanceof Error && error.message ? error.message : fallback;
}
