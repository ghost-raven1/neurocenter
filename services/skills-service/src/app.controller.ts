import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { access, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { SKILLS_STORAGE, ISkillsStorage } from './storage/skills-storage.interface';
import { checkReadiness } from '../../shared/readiness.cjs';

/**
 * Health-эндпоинт skills-service.
 */
@Controller()
export class AppController {
    constructor(@Inject(SKILLS_STORAGE) private readonly storage: ISkillsStorage) {}
    /** Создание короткого временного файла проверяет и реальную возможность записи. */
    @Get('ready')
    async ready(): Promise<unknown> {
        const state = await checkReadiness({
            storage: async () => {
                await access(this.storage.baseDir);
                const filename = path.join(this.storage.baseDir, '.ready-' + randomUUID());
                const handle = await open(filename, 'wx', 0o600);
                try {
                    await handle.writeFile('ready');
                } finally {
                    await handle.close();
                    await unlink(filename);
                }
            },
            durability: async () => {
                this.storage.assertDurability?.();
            },
            audit: async () => {
                if (await this.storage.pendingAudit?.()) {
                    throw new Error('Сохранённые изменения ожидают подтверждения аудита скиллов.');
                }
            },
        });
        if (!state.ok) {
            throw new ServiceUnavailableException(state);
        }
        return state;
    }
    /**
     * Health-check.
     *
     * @returns {{ ok: boolean }}
     */
    @Get('health')
    public health(): { ok: boolean } {
        return { ok: true };
    }
}
