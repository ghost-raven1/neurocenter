import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelsService } from './models.service';
import { RemoteConnectionService } from './remote-connection.service';
import { OpenCodeModelImport } from './opencode-model-import';

/** Приватная настройка доступна только главному администратору; ключ write-only. */
@Controller('api/models')
export class RemoteConnectionController {
    constructor(private readonly models: ModelsService, private readonly remote: RemoteConnectionService, private readonly opencode: OpenCodeModelImport) {}
    @Post('import-opencode')
    import(@Req() request: Request, @Body() body: unknown) { return this.opencode.import(request, body); }
    @Get(':id/connection')
    async read(@Param('id') id: string, @Req() request: Request) { await this.models.requireMain(request); const result = await this.remote.read(id); await this.models.requireMain(request); return result; }
    @Put(':id/connection')
    async save(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        const actor = await this.models.requireMain(request);
        return this.remote.save(id, body, actor, () => this.models.requireMain(request));
    }
    @Delete(':id/connection')
    async revoke(@Param('id') id: string, @Body() body: unknown, @Req() request: Request) {
        const actor = await this.models.requireMain(request);
        return this.remote.revoke(id, body, actor, () => this.models.requireMain(request));
    }
}
