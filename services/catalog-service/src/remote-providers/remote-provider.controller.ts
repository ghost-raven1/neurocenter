import { Body, Controller, Delete, Get, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ModelsService } from '../models/models.service';
import { ModelAutoVerification } from '../models/model-auto-verification';
import { RemoteProviderAccessService } from './remote-provider.service';

/** User identity comes exclusively from authenticated server context, never URL/body owner fields. */
@Controller('api/models')
export class RemoteProviderAccessController {
    constructor(
        private readonly access: RemoteProviderAccessService,
        private readonly models: ModelsService,
        private readonly verification: ModelAutoVerification,
    ) {}
    @Get(':id/my-access') read(@Req() req: Request, @Param('id') id: string) {
        return this.access.read(req, id);
    }
    @Put(':id/my-access') async save(@Req() req: Request, @Param('id') id: string, @Body() value: unknown) {
        const result = await this.access.mutate(req, id, value, 'save');
        // 8.19 P2-3: личный ключ сохранён — сервер сам повторяет проверку, без ручного «Проверить».
        const actor = await this.models.actor(req);
        this.verification.schedule(id, actor.email);
        return result;
    }
    @Delete(':id/my-access') async remove(@Req() req: Request, @Param('id') id: string, @Body() value: unknown) {
        const result = await this.access.mutate(req, id, value, 'delete');
        // 8.19 P2-3: личный ключ отозван — сервер сам повторяет проверку по актуальному доступу.
        const actor = await this.models.actor(req);
        this.verification.schedule(id, actor.email);
        return result;
    }
    @Get(':id/my-access/requests/:key') async receipt(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('key') key: string,
        @Res() res: Response,
    ) {
        return res.json(await this.access.receipt(req, id, key));
    }
}
