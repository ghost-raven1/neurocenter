import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { IModel, IModelList } from './model.types';
import { validateModelAssignment } from './model-validation';
import { ModelsService } from './models.service';

/** Общий реестр и состав проекта проверяют права повторно даже при прямом внутреннем запросе. */
@Controller('api')
export class ModelsController {
    constructor(private readonly models: ModelsService) {}

    @Get('models')
    list(@Req() req: Request, @Query('projectId') projectId?: string): Promise<IModelList> {
        return this.models.list(req, projectId);
    }

    @Get('models/:id')
    get(@Param('id') id: string, @Req() req: Request): Promise<IModel> {
        return this.models.getAccessible(id, req);
    }

    @Post('models')
    async create(@Body() body: unknown, @Req() req: Request): Promise<IModel> {
        const actor = await this.models.requireMain(req);
        if (
            !body ||
            typeof body !== 'object' ||
            Array.isArray(body) ||
            !('requestKey' in body) ||
            typeof body.requestKey !== 'string' ||
            !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(body.requestKey)
        )
            throw new BadRequestException('Передайте ключ создания модели для безопасного повтора.');
        const { requestKey, ...input } = body;
        if (!('runtime' in input) || !['remote-openai', 'remote-ollama'].includes(String(input.runtime)))
            throw new BadRequestException(
                'Локальная модель добавляется импортом проверенного ассета. Здесь можно создать подключение удалённого API.',
            );
        return this.models.create(input, actor, requestKey);
    }

    @Patch('models/:id')
    async update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<IModel> {
        return this.models.update(id, body, await this.models.requireMain(req));
    }

    @Delete('models/:id')
    async remove(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ ok: boolean }> {
        await this.models.remove(id, body, await this.models.requireMain(req));
        return { ok: true };
    }

    @Post('projects/:id/models')
    async assign(@Param('id') id: string, @Body() body: unknown, @Req() req: Request): Promise<{ ok: boolean }> {
        const actor = await this.models.actor(req);
        const project = await this.models.resolveProject(req, id, 3, actor);
        await this.models.assign(project.id, validateModelAssignment(body), actor.email);
        return { ok: true };
    }

    @Delete('projects/:id/models/:modelId')
    async unassign(
        @Param('id') id: string,
        @Param('modelId') modelId: string,
        @Req() req: Request,
    ): Promise<{ ok: boolean }> {
        const actor = await this.models.actor(req);
        const project = await this.models.resolveProject(req, id, 3, actor);
        return { ok: await this.models.unassign(project.id, modelId, actor.email) };
    }
}
