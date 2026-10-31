import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CatalogRequestsService } from './catalog-requests.service';
import type {
    ActionRequestBody,
    CreateRequestBody,
    EditRequestBody,
    RequestListQuery,
    TargetListQuery,
} from './request.types';
/** Browser users submit intent; current project roles govern review and completion. */
@Controller('api/catalog-requests')
export class CatalogRequestsController {
    constructor(private readonly requests: CatalogRequestsService) {}
    /** Мои заявки и очередь рассмотрения в доступных проектах. */
    @Get() list(@Req() req: Request, @Query() query: RequestListQuery) {
        return this.requests.list(req, query);
    }
    /** Существующие карточки выбранного типа и области проекта. */
    @Get('targets') targets(@Req() req: Request, @Query() query: TargetListQuery) {
        return this.requests.targets(req, query);
    }
    /** Заявка, текущие права и история её обработки. */
    @Get(':id') get(@Req() req: Request, @Param('id') id: string) {
        return this.requests.get(req, id);
    }
    /** Подать заявку на добавление, обновление или устранение проблемы. */
    @Post() create(@Req() req: Request, @Body() body: CreateRequestBody) {
        return this.requests.create(req, body);
    }
    /** Уточнить свою заявку с проверкой сохранённой ревизии. */
    @Patch(':id') edit(@Req() req: Request, @Param('id') id: string, @Body() body: EditRequestBody) {
        return this.requests.edit(req, id, body);
    }
    /** Рассмотреть заявку, запросить уточнение, отозвать или завершить её. */
    @Post(':id/actions') action(@Req() req: Request, @Param('id') id: string, @Body() body: ActionRequestBody) {
        return this.requests.action(req, id, body);
    }
}
