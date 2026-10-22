import type { IAiPlugin, ISkillFile, ISkillHistoryEntry } from '../../core/api/interfaces';
import { isAxiosError } from 'axios';
import type { IStoreApp, TStoreDetail } from '../../features/Catalog/types';
export type { TStoreDetail } from '../../features/Catalog/types';

/** Подтверждённое состояние задания приходит из Store, а не вычисляется по файлам. */
export interface IStoreInstallStatus {
    state: string;
    percent?: number;
    message?: string;
}

interface IInstallStatusView {
    title: string | null;
    tone: 'info' | 'success' | 'error' | 'warning';
    buttonLabel: string;
    busy: boolean;
    disabled: boolean;
    percent?: number;
    progressStatus: 'normal' | 'active' | 'success' | 'exception';
}

/** Показывает только полученный прогресс; завершение задания не доказывает запуск MCP. */
export function installStatusView(status?: IStoreInstallStatus, busy = false): IInstallStatusView {
    const state = status?.state;
    const active = state === 'queued' || state === 'running' || state === 'reconciling';
    const known = ['queued', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(state ?? '');
    const unknown = !!status && !known;
    const percent = typeof status?.percent === 'number' && Number.isFinite(status.percent)
        ? Math.max(0, Math.min(100, Math.round(status.percent))) : undefined;
    const titles: Record<string, string> = {
        queued: 'Установка в очереди', running: 'Установка выполняется', succeeded: 'Файлы установлены; запуск ещё не проверен',
        reconciling: 'Ожидаем подтверждения с компьютера',
        failed: 'Не удалось установить', cancelled: 'Установка отменена',
    };
    return {
        title: status ? known ? titles[status.state] : 'Статус установки уточняется' : busy ? 'Отправляем запрос на установку…' : null,
        tone: state === 'failed' ? 'error' : state === 'cancelled' ? 'warning' : state === 'succeeded' ? 'success' : 'info',
        buttonLabel: busy && !active ? 'Отправляем запрос…' : state === 'queued' ? 'В очереди' : state === 'running' ? 'Устанавливаем…'
            : state === 'reconciling' ? 'Сверяем результат' : state === 'succeeded' ? 'Файлы установлены' : state === 'failed' || state === 'cancelled' ? 'Повторить установку'
                : unknown ? 'Ожидаем статус' : 'Установить на компьютер',
        busy: busy || active,
        disabled: busy || active || state === 'succeeded' || unknown,
        percent,
        progressStatus: state === 'failed' ? 'exception' : state === 'succeeded' ? 'success' : active ? 'active' : 'normal',
    };
}

/** При отзыве доступа или удалении карточки предыдущие данные скрываются. */
export function keepDetailAfterRefreshError(error: unknown): boolean {
    const status = isAxiosError(error) ? error.response?.status : undefined;
    return ![401, 403, 404, 410].includes(status ?? 0);
}

interface IDetailsApi {
    getSkill: (path: string) => Promise<ISkillFile>;
    getAiPlugin: (id: string) => Promise<IAiPlugin>;
}

/** Загружает полные данные выбранной карточки вместо устаревшего списка. */
export async function loadStoreDetail(api: IDetailsApi, app: IStoreApp): Promise<TStoreDetail> {
    if(app.projectCard)return app.projectCard;
    if (app.kind === 'skill') {
        if (!app.path) { throw new Error('У скилла не указан путь в каталоге. Обновите страницу каталога.'); }
        return { kind: 'skill', skill: await api.getSkill(app.path) };
    }
    return { kind: 'bundle', plugin: await api.getAiPlugin(app.id) };
}

/** Не превращает отсутствующую или некорректную дату в выдуманные данные. */
export function formatDetailDate(value?: string): string {
    if (!value) { return 'Не указана'; }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) { return 'Не указана'; }
    return date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Показывает свежие записи первыми, не меняя ответ API. */
export function sortSkillHistory(history: ISkillHistoryEntry[]): ISkillHistoryEntry[] {
    return [...history].sort((left, right) => right.version - left.version);
}

type TPreviewConfig = (NonNullable<IAiPlugin['config']> & { headers?: Record<string, string> }) | null;
const PRIVATE_CONFIG_FIELDS = ['env', 'headers'] as const;

/** Проверяет, нужны ли пояснения к скрытым значениям конфигурации. */
export function hasConfigSecrets(config: TPreviewConfig): boolean {
    return !!config && PRIVATE_CONFIG_FIELDS.some(key => Object.keys(config[key] ?? {}).length > 0);
}

/** Значения окружения и заголовков не попадают в предпросмотр и его буфер обмена. */
export function previewConfig(config: TPreviewConfig): string {
    if (!config) { return ''; }
    const masked = { ...config };
    for (const key of PRIVATE_CONFIG_FIELDS) {
        if (config[key]) { masked[key] = Object.fromEntries(Object.keys(config[key]).map(name => [name, '••••••••'])); }
    }
    return JSON.stringify(masked, null, 2);
}

/** Относительные ресурсы не имеют подтверждённого адреса в текущем API каталога. */
export function instructionUrl(value: string): string | undefined {
    if (/[\u0000-\u0020\\]/.test(value)) { return undefined; }
    try {
        const url = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? value : undefined;
    } catch { return undefined; }
}
