/** Отказ безопасного генератора сообщает следующий шаг; случайный небезопасный ключ не подставляется. */
export function createBridgeRequestKey(generate: () => string = () => crypto.randomUUID()): string {
    try { return generate(); }
    catch { throw new Error('Не удалось подготовить запрос к мосту. Повторите действие; если ошибка останется, откройте сайт по HTTPS или через localhost.'); }
}
