import { Body, Controller, Delete, Get, Param, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RemoteProviderAccessService } from './remote-provider.service';

/** User identity comes exclusively from authenticated server context, never URL/body owner fields. */
@Controller('api/models')
export class RemoteProviderAccessController {
    constructor(private readonly access: RemoteProviderAccessService) {}
    @Get(':id/my-access') read(@Req() req: Request, @Param('id') id: string) {
        return this.access.read(req, id);
    }
    @Put(':id/my-access') save(@Req() req: Request, @Param('id') id: string, @Body() value: unknown) {
        return this.access.mutate(req, id, value, 'save');
    }
    @Delete(':id/my-access') remove(@Req() req: Request, @Param('id') id: string, @Body() value: unknown) {
        return this.access.mutate(req, id, value, 'delete');
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
