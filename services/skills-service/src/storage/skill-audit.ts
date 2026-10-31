import { createHash, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import {
    normalizeSkillAuditEvents,
    type ISkillAuditEvent,
    type ISkillAuditSummary,
} from '../../../shared/skill-audit.cjs';
import { normalizeMeta, parseSkillFile } from './frontmatter';
import type { ISkillFileChange } from './skill-journal';

export interface ISkillMutationContext {
    actor: string;
    source: ISkillAuditEvent['source'];
}
export type TDeliverSkillAudit = (events: ISkillAuditEvent[]) => Promise<void>;

/** Старое поколение получает стабильную идентичность без изменения сохранённого файла. */
export function skillAuditSummary(raw: string | null, skillPath: string): ISkillAuditSummary | null {
    if (raw === null) {
        return null;
    }
    const parsed = parseSkillFile(raw);
    if (!parsed.meta) {
        throw new Error('Повреждён frontmatter события аудита скилла.');
    }
    const meta = normalizeMeta(parsed.meta, skillPath.split('/').at(-1)!);
    return {
        generation:
            meta.generation || 'legacy-' + createHash('sha256').update(JSON.stringify(meta.history[0])).digest('hex'),
        version: meta.version,
        sha256: createHash('sha256').update(raw).digest('hex'),
    };
}

/** Событие описывает только реальное изменение; инструкция и ресурсы остаются в файловом журнале. */
export function skillAuditEvents(changes: ISkillFileChange[], context: ISkillMutationContext): ISkillAuditEvent[] {
    const at = new Date().toISOString();
    const events: ISkillAuditEvent[] = changes
        .filter((change) => change.before !== change.after)
        .map((change) => {
            const resourceId = change.relative.slice(0, -3);
            return {
                id: randomUUID(),
                at,
                actor: context.actor,
                source: context.source,
                resourceId,
                action:
                    change.before === null ? 'skill.create' : change.after === null ? 'skill.delete' : 'skill.update',
                before: skillAuditSummary(change.before, resourceId),
                after: skillAuditSummary(change.after, resourceId),
            };
        });
    const normalized: ISkillAuditEvent[] = [];
    for (let offset = 0; offset < events.length; offset += 200) {
        normalized.push(...normalizeSkillAuditEvents({ events: events.slice(offset, offset + 200) }));
    }
    return normalized;
}

/** Создание папки использует тот же стабильный outbox без выдуманной версии файла. */
export function skillDirectoryAuditEvents(relative: string, actor: string): ISkillAuditEvent[] {
    return normalizeSkillAuditEvents({
        events: [
            {
                id: randomUUID(),
                at: new Date().toISOString(),
                actor,
                source: 'editor',
                action: 'skill.directory.create',
                resourceId: relative,
                before: null,
                after: { directory: true },
            },
        ],
    });
}

/** Каталог подтверждает каждый пакет; потерянный ACK безопасно повторяется с прежними UUID. */
export async function deliverSkillAudit(events: ISkillAuditEvent[]): Promise<void> {
    if (!events.length) {
        return;
    }
    const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!token) {
        throw new ServiceUnavailableException('Не настроен внутренний доступ для аудита скиллов.');
    }
    let endpoint: URL;
    try {
        const base = new URL(process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:4100');
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
            throw new Error();
        }
        endpoint = new URL('/internal/skill-audit/events', base);
    } catch {
        throw new ServiceUnavailableException('Некорректно настроен адрес каталога аудита.');
    }
    for (let offset = 0; offset < events.length; offset += 200) {
        const chunk = normalizeSkillAuditEvents({ events: events.slice(offset, offset + 200) });
        let response: Response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                redirect: 'error',
                signal: AbortSignal.timeout(5000),
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
                body: JSON.stringify({ events: chunk }),
            });
            const result = (await response.json()) as { accepted?: unknown };
            if (!response.ok || result.accepted !== chunk.length) {
                throw new Error();
            }
        } catch {
            throw new ServiceUnavailableException(
                'Каталог не подтвердил аудит скиллов; событие сохранено для повтора.',
            );
        }
    }
}
