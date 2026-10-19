import { isAxiosError } from 'axios';

/** Отзыв доступа не разрешает показывать прежние данные как доступные. */
export function operationReadStatus(failure: unknown): number | undefined {
    return isAxiosError(failure) ? failure.response?.status : undefined;
}
