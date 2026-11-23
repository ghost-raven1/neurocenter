/** Вход error-события для outbox (писатели без прямого PG, AD-O5). */
export interface IErrorOutboxEvent {
  /** Уникальный UUID; прилагается автоматически, если не задан. */
  id?: string;
  service: string;
  level: 'error' | 'critical';
  /** requestId контекста 6.6 либо null. */
  requestId?: string | null;
  /** Фиксированный классификатор (без значений, AD-O8). */
  message: string;
  /** Кадры + имена, trunc 4 KB, без значений; null, если нет. */
  stackHint?: string | null;
}

export interface IErrorOutboxOptions {
  /** Период фоновой доставки, мс (default 2000). */
  intervalMs?: number;
  logger?: {
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

/**
 * Общий file outbox error-событий (api-gateway, feature-flags, oauth2-bridge,
 * rag-sync, skills → catalog). Та же механика, что у security-outbox:
 * файл на событие (id = ключ дедупликации), 2s timer, epoch, retry, карантин;
 * deliver бросает ошибку при недоступности catalog — файлы остаются и
 * доставляются при следующем цикле.
 */
export declare class ErrorOutbox {
  constructor(
    root: string,
    deliver?: (events: IErrorOutboxEvent[]) => Promise<void>,
    options?: IErrorOutboxOptions,
  );
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Сохраняет события в outbox; id прилагается, если не задан. */
  append(events: IErrorOutboxEvent[]): Promise<number>;
  /** Доставка с предупреждением, без падения сервиса. */
  tryFlush(): Promise<void>;
  /** Single-flight доставка всех pending-событий (батчи ≤200). */
  flush(): Promise<void>;
  /** Есть ли неподтверждённые события? */
  pending(): Promise<boolean>;
}

/**
 * Доставка пакета error-событий в catalog POST /internal/error-events
 * (x-neurocenter-internal, конверт { events }, X-Request-ID — internalFetch).
 * Бросает ошибку при недоступности каталога — outbox повторит доставку.
 */
export declare function deliverErrorEvents(events: IErrorOutboxEvent[]): Promise<void>;
