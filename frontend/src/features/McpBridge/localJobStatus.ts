import type {IBridgeJob} from './api';

/** Принятие задания не подтверждает выполнение или готовность инструмента. */
export function localJobStatus(job: IBridgeJob): {title: string; description: string} {
    if (job.state === 'queued') { return {title: 'Задание принято', description: 'Выполнение ещё не подтверждено. Дождитесь ответа моста или отмените задание.'}; }
    if (job.state === 'reconciling') { return {title: 'Сверяем результат действия', description: 'Мост уточняет результат. Повторный запуск пока недоступен.'}; }
    return {title: 'Действие выполняется', description: ''};
}
