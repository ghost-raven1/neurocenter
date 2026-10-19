import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { ProxyService } from './proxy.service';

/**
 * Проксирует всё /api/* на каталожный microservice (CATALOG_SERVICE_URL).
 * Сохраняет method/query/body/headers (включая session cookie — для auth-guard позже).
 */
@Controller('api')
export class ProxyController {
    constructor(private readonly proxy: ProxyService) {}

    /**
     * Делегирует запрос в каталог.
     *
     * @param {Request} req - входящий запрос
     * @param {Response} res - исходящий ответ
     * @returns {Promise<void>}
     */
    @All('{*path}')
    public all(@Req() req: Request, @Res() res: Response): Promise<void> {
        return this.proxy.forward(req, res);
    }
}
