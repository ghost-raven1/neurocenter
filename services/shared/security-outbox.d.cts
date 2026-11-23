/** Вход security-события для outbox (писатели без прямого PG). */
export interface ISecurityOutboxEvent {
  eventId?: string;
  actor: string;
  action: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
}

export interface ISecurityOutboxOptions {
  /** Период фоновой доставки, мс (default 2000). */
  intervalMs?: number;
  logger?: {
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

/**
 * Общий file outbox security-событий (oauth2-bridge, api-gateway → catalog).
 * Файл на событие (eventId = ключ идемпотентности), 2s timer, epoch, retry;
 * deliver бросает ошибку при недоступности catalog — файлы остаются и
 * доставляются при следующем цикле.
 */
export declare class SecurityOutbox {
  constructor(
    root: string,
    deliver?: (events: ISecurityOutboxEvent[]) => Promise<void>,
    options?: ISecurityOutboxOptions,
  );
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Сохраняет события в outbox; eventId прилагается, если не задан. */
  append(events: ISecurityOutboxEvent[]): Promise<number>;
  /** Доставка с предупреждением, без падения сервиса. */
  tryFlush(): Promise<void>;
  /** Single-flight доставка всех pending-событий (батчи ≤200). */
  flush(): Promise<void>;
  /** Есть ли неподтверждённые события? */
  pending(): Promise<boolean>;
}

/**
 * Доставка пакета security-событий в catalog POST /internal/security-events
 * (x-neurocenter-internal, конверт { events }). Бросает ошибку при
 * недоступности каталога — outbox повторит доставку.
 */
export declare function deliverSecurityEvents(events: ISecurityOutboxEvent[]): Promise<void>;
