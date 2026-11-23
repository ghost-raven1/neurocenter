'use strict';

/**
 * Общий file outbox для error-событий писателей без прямого PG
 * (api-gateway, feature-flags-service, oauth2-bridge, rag-sync-service,
 * skills-service). Та же механика, что у security-outbox.cjs (паттерн
 * skill-audit-outbox): файл на событие + 2s timer + epoch + retry +
 * карантин повреждённых файлов; deliver = HTTP POST в catalog
 * /internal/error-events.
 *
 * Error-события имеют уникальный UUID (crash — разовое событие);
 * повторная доставка не дублирует запись: catalog вставляет
 * ON CONFLICT (id) DO NOTHING (AD-O5).
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { internalFetch } = require('./request-context.cjs');

const BATCH_SIZE = 200;
const LEVELS = new Set(['error', 'critical']);

class ErrorOutbox {
    /**
     * @param {string} root каталог outbox (создаётся при start()/append()).
     * @param {(events: Array<Record<string, unknown>>) => Promise<void>} [deliver]
     *        доставка пакета ≤200 событий; бросает ошибку при недоступности catalog.
     * @param {{ intervalMs?: number, logger?: { warn?: (msg: string) => void, error?: (msg: string) => void } }} [options]
     */
    constructor(root, deliver, options = {}) {
        this.root = root;
        this.deliver = deliver;
        this.intervalMs = options.intervalMs ?? 2000;
        this.logger = options.logger ?? {};
        this.timer = undefined;
        this.delivery = undefined;
        this.warned = false;
        this.epoch = 0;
    }

    async start() {
        await fs.mkdir(this.root, { recursive: true });
        if (this.deliver && !this.timer) {
            this.timer = setInterval(() => {
                void this.tryFlush();
            }, this.intervalMs);
            this.timer.unref?.();
        }
    }

    async stop() {
        this.epoch++;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.delivery?.catch(() => undefined);
    }

    /**
     * Сохраняет события в outbox (атомарная запись: tmp + rename).
     * id прилагается автоматически — это ключ дедупликации в catalog.
     * @returns {Promise<number>} сколько файлов сохранено.
     */
    async append(events) {
        let count = 0;
        for (const event of events) {
            if (
                !event ||
                typeof event !== 'object' ||
                typeof event.service !== 'string' ||
                !event.service ||
                typeof event.message !== 'string' ||
                !event.message ||
                typeof event.level !== 'string' ||
                !LEVELS.has(event.level)
            ) {
                throw new Error('Error-событие требует service, level (error|critical) и message.');
            }
            if (event.requestId !== undefined && event.requestId !== null && typeof event.requestId !== 'string') {
                throw new Error('requestId error-события должен быть строкой или null.');
            }
            if (event.stackHint !== undefined && event.stackHint !== null && typeof event.stackHint !== 'string') {
                throw new Error('stackHint error-события должен быть строкой или null.');
            }
            const id = event.id && typeof event.id === 'string' ? event.id : crypto.randomUUID();
            const filename = `${id}.json`;
            // Каталог может отсутствовать до start(): crash-репорт пишется до exit.
            await fs.mkdir(this.root, { recursive: true });
            const target = path.join(this.root, filename);
            const tmp = path.join(this.root, `.${filename}.tmp`);
            const record = {
                ...event,
                id,
                requestId: event.requestId ?? null,
                stackHint: event.stackHint ?? null,
            };
            await fs.writeFile(tmp, JSON.stringify(record, null, 2));
            await fs.rename(tmp, target);
            count++;
        }
        return count;
    }

    /** Доставка с предупреждением, но без падения сервиса (best-effort, как skill-audit). */
    async tryFlush() {
        try {
            await this.flush();
            this.warned = false;
        } catch {
            if (!this.warned) {
                this.logger.warn?.('Error outbox: события ждут доставки в каталог.');
                this.warned = true;
            }
        }
    }

    /** Single-flight: параллельные вызовы не гоняют две доставки. */
    async flush() {
        if (this.delivery) {
            return this.delivery;
        }
        const work = this.deliverPending();
        this.delivery = work;
        try {
            await work;
        } finally {
            if (this.delivery === work) {
                this.delivery = undefined;
            }
        }
    }

    async deliverPending() {
        const epoch = this.epoch;
        let names = [];
        try {
            names = (await fs.readdir(this.root)).filter((name) => name.endsWith('.json')).sort();
        } catch {
            return;
        }
        for (let offset = 0; offset < names.length && this.epoch === epoch; offset += BATCH_SIZE) {
            const events = [];
            const byId = new Map();
            for (const name of names.slice(offset, offset + BATCH_SIZE)) {
                const file = path.join(this.root, name);
                let parsed;
                try {
                    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        continue;
                    }
                    // Повреждённый файл не должен блокировать outbox: в карантин с ошибкой.
                    const quarantine = path.join(this.root, `corrupt-${name}`);
                    await fs.rename(file, quarantine).catch(() => undefined);
                    this.logger.error?.(`Error outbox: повреждённый файл ${name} перемещён в карантин.`);
                    continue;
                }
                if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string' || !parsed.id) {
                    const quarantine = path.join(this.root, `corrupt-${name}`);
                    await fs.rename(file, quarantine).catch(() => undefined);
                    this.logger.error?.(`Error outbox: файл ${name} без id, перемещён в карантин.`);
                    continue;
                }
                events.push(parsed);
                byId.set(parsed.id, file);
            }
            if (!events.length) {
                continue;
            }
            if (!this.deliver) {
                return;
            }
            await this.deliver(events);
            if (this.epoch !== epoch) {
                return;
            }
            // Файлы удаляем только после подтверждения доставки; повторная
            // доставка того же id не дублирует запись в catalog (ON CONFLICT).
            for (const file of byId.values()) {
                try {
                    await fs.unlink(file);
                } catch (error) {
                    if (error.code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
        }
    }

    /** Есть ли неподтверждённые события в outbox? */
    async pending() {
        try {
            const names = await fs.readdir(this.root);
            return names.some((name) => name.endsWith('.json'));
        } catch {
            return true;
        }
    }
}

/**
 * Доставка пакета error-событий в catalog (internal HTTP).
 * Бросает ошибку при недоступности каталога — outbox оставит файлы и повторит.
 * @param {Array<Record<string, unknown>>} events пакет ≤200 событий.
 */
async function deliverErrorEvents(events) {
    if (!events.length) {
        return;
    }
    const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!token) {
        throw new Error('NEUROCENTER_INTERNAL_TOKEN не настроен для доставки error-событий.');
    }
    let endpoint;
    try {
        const base = new URL(process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:4100');
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
            throw new Error();
        }
        endpoint = new URL('/internal/error-events', base);
    } catch {
        throw new Error('Некорректно настроен адрес каталога для error-событий.');
    }
    for (let offset = 0; offset < events.length; offset += 200) {
        const chunk = events.slice(offset, offset + 200);
        let response;
        try {
            response = await internalFetch(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
                body: JSON.stringify({ events: chunk }),
            });
            const result = (await response.json().catch(() => ({}))) || {};
            if (!response.ok || result.received !== chunk.length) {
                throw new Error();
            }
        } catch {
            throw new Error('Каталог не подтвердил error-события; события сохранены для повтора.');
        }
    }
}

module.exports = { ErrorOutbox, deliverErrorEvents };
