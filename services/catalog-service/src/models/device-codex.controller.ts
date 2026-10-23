import { Controller, Get, Post, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from './models.service';
import { DeviceCodexService } from './device-codex.service';
/** Passive availability checks never send a paid model request. */
@Controller('api/models')
export class DeviceCodexController {
    constructor(private readonly models: ModelsService, private readonly codex: DeviceCodexService) { }
    @Get(':id/device-connection')
    async read(
    @Param('id')
    id: string, 
    @Req()
    req: Request) {
        const actor = await this.models.actor(req), model = await this.models.getAccessible(id, req);
        return this.codex.status(model, actor);
    }
    @Post(':id/device-connection/check')
    async check(
    @Param('id')
    id: string, 
    @Req()
    req: Request) {
        const current = await this.read(id, req);
        return { ...current, message: current.state === 'ready' ? 'Доступность компьютера проверена; запрос к модели ещё не выполнялся.' : current.message };
    }
}
