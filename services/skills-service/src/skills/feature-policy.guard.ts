import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';

import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

import { requiredRouteFeatures } from '../../../shared/feature-policy.cjs';
import { FeatureFlagError, requireFeaturesEnabled } from '../../../shared/feature-client.cjs';

/**
 * Guard для проверки доступа к функциям публикации Skills.
 *
 * Работает независимо от браузера и Catalog Import Worker.
 *
 * Основные задачи:
 * 1. Определить, какие функции требуются для текущего запроса.
 * 2. Проверить, что запрос пришёл через авторизованный внутренний шлюз.
 * 3. Проверить, включены ли необходимые Feature Flags.
 * 4. Запретить выполнение запроса, если проверка не пройдена.
 */
@Injectable()
export class SkillFeaturePolicyGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        // Получаем HTTP-запрос из контекста NestJS.
        const request = context.switchToHttp().getRequest<Request>();

        // Определяем, какие Feature Flags нужны для этого маршрута.
        // Учитываются HTTP-метод, путь и тело запроса.
        const requiredFeatures = requiredRouteFeatures(request.method, request.path, request.body);

        // Если для маршрута не нужны специальные функции,
        // разрешаем выполнение запроса.
        if (requiredFeatures.length === 0) {
            return true;
        }

        // Получаем внутренний токен из HTTP-заголовка.
        const receivedToken = request.headers['x-neurocenter-internal'];

        // Получаем ожидаемый токен из переменных окружения.
        const expectedToken = process.env.NEUROCENTER_INTERNAL_TOKEN;

        // Проверяем наличие токена и его корректность.
        //
        // timingSafeEqual используется для сравнения токенов
        // с защитой от атак по времени выполнения сравнения.
        //
        // Сначала проверяем тип и длину, поскольку
        // timingSafeEqual требует одинаковую длину буферов.
        const isAuthorized =
            typeof expectedToken === 'string' &&
            expectedToken.length > 0 &&
            typeof receivedToken === 'string' &&
            Buffer.byteLength(receivedToken) === Buffer.byteLength(expectedToken) &&
            timingSafeEqual(Buffer.from(receivedToken), Buffer.from(expectedToken));

        // Если токен отсутствует или неверный,
        // запрещаем доступ к маршруту.
        if (!isAuthorized) {
            throw new ForbiddenException('Запрос должен пройти через авторизованный шлюз.');
        }

        try {
            // Проверяем, включены ли все необходимые Feature Flags.
            //
            // Если хотя бы одна функция отключена,
            // сервис проверки может выбросить FeatureFlagError.
            await requireFeaturesEnabled(requiredFeatures);
        } catch (error) {
            // Если функция отключена и сервис вернул статус 403,
            // возвращаем клиенту подробную информацию об ограничении.
            if (error instanceof FeatureFlagError && error.status === 403) {
                throw new ForbiddenException({
                    code: error.code,
                    message: error.message,
                    feature: error.feature,
                    blockedBy: error.blockedBy,
                });
            }

            // Если произошла другая ошибка:
            // например, сервис Feature Flags недоступен,
            // возвращаем HTTP 503.
            throw new ServiceUnavailableException('Не удалось проверить доступность функции.');
        }

        // Все проверки пройдены.
        // NestJS разрешает выполнение контроллера.
        return true;
    }
}
