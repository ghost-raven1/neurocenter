import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import os from 'node:os';
import path from 'node:path';
import {
    SecurityOutbox,
    deliverSecurityEvents,
    type ISecurityOutboxEvent,
} from '../../../../shared/security-outbox.cjs';
import { createLogger } from '../../../../shared/logging.cjs';

const log = createLogger('api-gateway');

/**
 * P0-RES/AD-O7: security-события gateway (oauth2-bridge и gateway без прямого PG).
 * File outbox + 2s timer (паттерн skill-audit-outbox); доставка —
 * POST catalog /internal/security-events, идемпотентность — event_id.
 */
@Injectable()
export class SecurityAuditService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SecurityAuditService.name);
    readonly outbox = new SecurityOutbox(
        process.env.SECURITY_OUTBOX_PATH
            ? path.resolve(process.env.SECURITY_OUTBOX_PATH)
            : path.join(os.tmpdir(), 'neurocenter', 'security-outbox', 'api-gateway'),
        deliverSecurityEvents,
        { logger: this.logger },
    );

    async onModuleInit(): Promise<void> {
        await this.outbox.start();
    }

    async onModuleDestroy(): Promise<void> {
        await this.outbox.stop();
    }

    /** Файловая запись outbox не должна ломать канал; доставка — фоновая. */
    event(input: Omit<ISecurityOutboxEvent, 'eventId'> | ISecurityOutboxEvent): void {
        void this.outbox.append([input]).catch((error) => {
            // AD-O8: error.stack/message не уходят — shared-логгер применяет allowlist name/code/causeCode.
            log.error('Не удалось сохранить security-событие в outbox.', { err: error });
        });
    }
}
