import fs from 'node:fs/promises';
import { Logger } from '@nestjs/common';
import {
    archiveSkillJournal,
    confirmSkillJournal,
    readSkillJournal,
    retrySkillJournalDurability,
    skillJournalFiles,
    withSkillScope,
} from './skill-journal';
import { assertSkillDurability, markSkillDurabilityUncertain, withSkillCommit } from './skill-durability';
import path from 'node:path';
import type { TDeliverSkillAudit } from './skill-audit';

/** Файловый outbox удаляется только после подтверждения всех стабильных UUID каталога. */
export class SkillAuditOutbox {
    private readonly logger = new Logger(SkillAuditOutbox.name);
    private timer?: ReturnType<typeof setInterval>;
    private delivery?: Promise<void>;
    private warned = false;
    private epoch = 0;
    constructor(
        private readonly root: string,
        private readonly deliver?: TDeliverSkillAudit,
    ) {}

    async start(): Promise<void> {
        await this.afterMutation();
        if (this.deliver && !this.timer) {
            this.timer = setInterval(() => {
                void this.tryFlush();
            }, 2000);
            this.timer.unref();
        }
    }

    async stop(): Promise<void> {
        this.epoch++;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        await this.delivery?.catch(() => undefined);
    }

    /** Публикация файла успешна даже при недоступности каталога; готовность показывает оставшийся outbox. */
    async tryFlush(): Promise<void> {
        try {
            await this.flush();
            this.warned = false;
        } catch {
            if (!this.warned) {
                this.logger.warn('Сохранённые изменения скиллов ожидают подтверждения аудита.');
                this.warned = true;
            }
        }
    }

    /** Быстрый ACK ждём до 250 мс; длинная очередь доставляется в фоне без повторной файловой записи. */
    async afterMutation(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.tryFlush(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 250);
                }),
            ]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    async flush(): Promise<void> {
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

    private async deliverPending(): Promise<void> {
        const epoch = this.epoch;
        await retrySkillJournalDurability(this.root);
        if (!this.deliver || this.epoch !== epoch) {
            return;
        }
        for (const filename of await skillJournalFiles(this.root)) {
            if (this.epoch !== epoch) {
                return;
            }
            let stable = filename;
            if (!path.basename(filename).startsWith('audit-')) {
                let scope: string;
                try {
                    scope = (await readSkillJournal(filename)).changes[0].relative.split('/')[0];
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        continue;
                    }
                    throw error;
                }
                const archived = await withSkillScope(this.root, scope, async () => {
                    let current;
                    try {
                        current = await readSkillJournal(filename);
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            return undefined;
                        }
                        throw error;
                    }
                    if (current.state !== 'committed') {
                        return undefined;
                    }
                    await archiveSkillJournal(filename, current);
                    return current.events?.length
                        ? path.join(path.dirname(filename), 'audit-' + current.id + '.json')
                        : undefined;
                });
                if (!archived) {
                    continue;
                }
                stable = archived;
            }
            let snapshot;
            try {
                snapshot = await readSkillJournal(stable);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
            await withSkillCommit(this.root, snapshot, async () => {
                let journal;
                try {
                    journal = await readSkillJournal(stable);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        return;
                    }
                    throw error;
                }
                if (journal.state !== 'committed' || path.basename(stable) !== 'audit-' + journal.id + '.json') {
                    throw new Error('Повреждён журнал исходящих событий аудита скиллов.');
                }
                await withSkillScope(this.root, journal.changes[0].relative.split('/')[0], () =>
                    confirmSkillJournal(this.root, stable, journal),
                );
                assertSkillDurability(this.root);
                for (let offset = 0; offset < (journal.events?.length ?? 0); offset += 200) {
                    if (this.epoch !== epoch) {
                        return;
                    }
                    await this.deliver!(journal.events!.slice(offset, offset + 200));
                }
                if (this.epoch !== epoch) {
                    return;
                }
                try {
                    await fs.unlink(stable);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'EIO') {
                        throw markSkillDurabilityUncertain(this.root, stable, journal, true);
                    }
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error;
                    }
                }
                await confirmSkillJournal(this.root, stable, journal, true);
            });
        }
    }

    /** Ошибка чтения тоже означает неподтверждённый аудит, без ложной ошибки уже выполненной записи. */
    async pending(skillPath?: string, recursive = false): Promise<boolean> {
        try {
            for (const filename of await skillJournalFiles(this.root)) {
                let journal;
                try {
                    journal = await readSkillJournal(filename);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        continue;
                    }
                    throw error;
                }
                if (journal.state !== 'committed') {
                    continue;
                }
                if (
                    journal.events?.some(
                        (event) =>
                            skillPath === undefined ||
                            event.resourceId === skillPath ||
                            (recursive && event.resourceId.startsWith(skillPath + '/')),
                    )
                ) {
                    return true;
                }
            }
            return false;
        } catch {
            return true;
        }
    }
}
