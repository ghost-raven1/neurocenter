import { BadRequestException, Controller, ForbiddenException, Get, Inject, Query, Req } from '@nestjs/common';

import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { SKILLS_STORAGE, type ISkillsStorage } from '../storage/skills-storage.interface';

import { scanSkillDependencyUsage } from '../storage/skill-dependency-usage';

/**
 * Внутренний контроллер для проверки использования MCP и плагинов.
 *
 * Назначение:
 * определить, используется ли указанный asset в зависимостях скиллов.
 *
 * Контроллер не раскрывает:
 * - содержимое скиллов;
 * - пути к файлам;
 * - метаданные скиллов;
 * - список найденных зависимостей.
 */
@Controller('internal/skill-dependencies')
export class SkillDependenciesController {
    constructor(
        @Inject(SKILLS_STORAGE)
        private readonly storage: ISkillsStorage,
    ) {}

    /**
     * Проверяет, используется ли MCP или плагин с указанным ID.
     *
     * GET /internal/skill-dependencies/usage?assetId=ai-plug-example
     *
     * Авторизация:
     * заголовок x-neurocenter-internal должен содержать
     * внутренний токен из переменной окружения.
     *
     * Ответ:
     * { inUse: true }  — зависимость используется;
     * { inUse: false } — зависимость не используется.
     */
    @Get('usage')
    async usage(@Req() request: Request, @Query('assetId') assetId: string): Promise<{ inUse: boolean }> {
        // ----------------------------------------------
        // 1. Проверка внутреннего токена
        // ----------------------------------------------

        // Ожидаемый токен из переменной окружения.
        const expectedToken = Buffer.from(process.env.NEUROCENTER_INTERNAL_TOKEN || '');

        // Получаем токен из HTTP-заголовка.
        const tokenHeader = request.headers['x-neurocenter-internal'];

        // Заголовок должен содержать строковое значение.
        const suppliedToken = Buffer.from(typeof tokenHeader === 'string' ? tokenHeader : '');

        // Не разрешаем доступ, если:
        // - токен не настроен;
        // - длина токенов различается;
        // - значения токенов не совпадают.
        //
        // timingSafeEqual снижает риск атак по времени
        // при сравнении токенов одинаковой длины.
        const isAuthorized =
            expectedToken.length > 0 &&
            suppliedToken.length === expectedToken.length &&
            timingSafeEqual(suppliedToken, expectedToken);

        if (!isAuthorized) {
            throw new ForbiddenException('Требуется внутренний доступ.');
        }

        // ----------------------------------------------
        // 2. Проверка идентификатора ресурса
        // ----------------------------------------------

        // Разрешённый формат:
        // ai-plug-<идентификатор>
        //
        // Допускаются:
        // - строчные латинские буквы;
        // - цифры;
        // - символы "_" и "-".
        //
        // Первый символ после ai-plug- должен быть
        // латинской буквой или цифрой.
        // Максимальная длина суффикса — 120 символов.
        const isValidAssetId = typeof assetId === 'string' && /^ai-plug-[a-z0-9][a-z0-9_-]{0,119}$/.test(assetId);

        if (!isValidAssetId) {
            throw new BadRequestException('Укажите ID MCP или плагина.');
        }

        // ----------------------------------------------
        // 3. Проверка использования зависимости
        // ----------------------------------------------

        // Сканируем зависимости скиллов в хранилище.
        // Возвращаем только булев результат, не раскрывая
        // внутреннюю структуру найденных записей.
        const inUse = await scanSkillDependencyUsage(this.storage.baseDir, assetId);

        return { inUse };
    }
}
