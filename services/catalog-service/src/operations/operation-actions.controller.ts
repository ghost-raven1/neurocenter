import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OperationActionsService } from './operation-actions.service';

/** Владелец, актуальные права и CAS проверяются dispatcher и настоящим исполнителем. */
@Controller('api/operations')
export class OperationActionsController {
    constructor(private readonly actions: OperationActionsService) {}
    @Post(':id/retry') retry(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.actions.dispatch(req, id, 'retry', body);
    }
    @Post(':id/cancel') cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.actions.dispatch(req, id, 'cancel', body);
    }
}
