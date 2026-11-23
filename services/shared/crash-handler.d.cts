/**
 * AD-O5 (res-obs 6.10): crash-событие для error-store.
 * Только safe-поля: message — фиксированный классификатор (crash.<kind>),
 * stackHint — кадры + имена без значений (AD-O8).
 */
export interface ICrashErrorEvent {
  /** Уникальный UUID события (дедупликация в catalog: ON CONFLICT (id)). */
  id: string;
  service: string;
  /** crash (uncaughtException/unhandledRejection) = всегда critical. */
  level: 'critical';
  /** requestId контекста 6.6 либо null (вне запроса/фоновой работы). */
  requestId: string | null;
  /** Фиксированный классификатор: 'crash.uncaughtException' | 'crash.unhandledRejection'. */
  message: string;
  /** Кадры + имена ошибки, trunc 4 KB, без значений переменных (AD-O8). */
  stackHint: string;
}

/** Минимальный интерфейс логгера 6.6, нужных crash-политике. */
export interface ICrashHandlerLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface IInstallCrashHandlerParams {
  service: string;
  log: ICrashHandlerLogger;
  /** Запись в error-store (best-effort; бросок/зависание не блокируют exit). */
  reportError: (event: ICrashErrorEvent) => unknown;
  /** Опциональный in-process счётчик метрик (observability). */
  record?: (level: 'error' | 'critical') => void;
}

/**
 * AD-O8 stack-hint (OQ-1): кадры (file:line:col) + имя/код ошибки — без
 * значений переменных и без первой строки err.stack (там error.message).
 * Top-20 кадров, не более 4 KB.
 */
export function buildStackHint(
  reason: unknown,
  options?: {
    maxFrames?: number;
    maxBytes?: number;
  },
): string;

/**
 * Единая crash-политика: uncaughtException/unhandledRejection →
 * structured-лог (safe) → error-store (best-effort, timeout 2 s) →
 * process.exit(1) всегда («catch и continue» запрещено).
 * Возвращает dispose() — снятие обработчиков (тесты).
 */
export function installCrashHandler(params: IInstallCrashHandlerParams): () => void;
