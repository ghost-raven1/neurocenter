import type { IRagResult } from './ragResult.interfaces';

import { messages } from './constants';

/** HTTP 200 не означает успех операции: проверяем результат моста до показа уведомления. */
export function requireRagSuccess<T extends IRagResult>(result: T): T {
    if (!result.ok) {
        throw new Error(
            messages[result.error ?? ''] ??
                result.message ??
                'Операция с базой знаний не выполнена. Проверьте состояние проекта и повторите попытку.',
        );
    }
    return result;
}
