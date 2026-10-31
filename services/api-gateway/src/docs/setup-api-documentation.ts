import type { INestApplication } from '@nestjs/common';
import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import type { IAuthPayload } from '../auth/auth-guard.service';
import { swaggerUiOptions } from './swagger-ui-options';

interface DocumentationAuth {
    authenticate(request: Request): Promise<IAuthPayload | null>;
}

const documentationPath = (value: string): boolean => {
    const route = value.toLowerCase();
    return route === '/api/docs' || route.startsWith('/api/docs/');
};

/** Register before Nest's proxy wildcard: every document and asset request checks fresh session access. */
export function setupApiDocumentation(app: INestApplication, auth: DocumentationAuth, document?: OpenAPIObject): void {
    const definition =
        document ?? (JSON.parse(readFileSync(path.join(__dirname, 'openapi.json'), 'utf8')) as OpenAPIObject);
    app.use(async (request: Request, response: Response, next: NextFunction): Promise<void> => {
        if (!documentationPath(request.path)) {
            next();
            return;
        }
        response.setHeader('Cache-Control', 'no-store');
        if (!['GET', 'HEAD'].includes(request.method)) {
            response.setHeader('Allow', 'GET, HEAD');
            response.status(405).json({ message: 'Документация доступна только для чтения.' });
            return;
        }
        if (request.headers.authorization) {
            response.status(403).json({ message: 'Войдите в Нейроцентр через браузер для просмотра документации.' });
            return;
        }
        let actor: IAuthPayload | null;
        try {
            actor = await auth.authenticate(request);
        } catch {
            response.status(503).json({ message: 'Не удалось проверить вход. Повторите позже.' });
            return;
        }
        if (!actor) {
            response.status(401).json({ message: 'Для просмотра документации войдите в Нейроцентр.' });
            return;
        }
        if (actor.deviceId) {
            response.status(403).json({ message: 'Документация доступна пользователю в браузере.' });
            return;
        }
        next();
    });
    SwaggerModule.setup('/api/docs', app, definition, {
        raw: ['json'],
        jsonDocumentUrl: '/api/docs/openapi.json',
        customSiteTitle: 'Нейроцентр — API',
        swaggerOptions: swaggerUiOptions,
    });
    app.use((request: Request, response: Response, next: NextFunction): void => {
        if (!documentationPath(request.path)) {
            next();
            return;
        }
        response.status(404).json({ message: 'Файл документации не найден.' });
    });
}
