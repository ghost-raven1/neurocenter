interface IRagResult { ok: boolean; error?: string; message?: string; note?: string; }

const messages: Record<string, string> = {
    'empty-source': 'На сервере пока нет данных проекта. Сначала отправьте локальную базу знаний.',
    'store-not-found': 'Локальная база знаний не найдена. Проверьте папку проекта и создайте индекс в OpenCode.',
    'incomplete-source': 'Скачивание не завершено. Повторите попытку: локальные данные сохранены.',
};

/** HTTP 200 не означает успех операции: проверяем результат моста до показа уведомления. */
export function requireRagSuccess<T extends IRagResult>(result: T): T {
    if (!result.ok) { throw new Error(messages[result.error ?? ''] ?? result.message ?? 'Операция с базой знаний не выполнена. Проверьте состояние проекта и повторите попытку.'); }
    return result;
}
