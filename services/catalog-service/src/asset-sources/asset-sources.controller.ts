import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Put,
    Query,
    Req,
    Res,
    UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertInternal } from '../access/access.controller';
import { AssetSourcesService } from './asset-sources.service';

@Controller('api')
export class AssetSourcesController {
    constructor(private readonly service: AssetSourcesService) {}
    @Get('asset-sources') async source(@Req() req: Request) {
        await this.service.actor(req);
        return this.service.view();
    }
    @Post('asset-sources/refresh') async refresh(@Req() req: Request) {
        await this.service.actor(req);
        return this.service.refresh();
    }
    @Put('asset-sources/archive') async archive(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        if (
            String(req.headers['content-type'] || '')
                .split(';')[0]
                .trim()
                .toLowerCase() !== 'application/octet-stream' ||
            !['', 'identity'].includes(
                String(req.headers['content-encoding'] || '')
                    .trim()
                    .toLowerCase(),
            )
        ) {
            res.setHeader('Connection', 'close');
            throw new UnsupportedMediaTypeException(
                'Передайте архив потоком application/octet-stream без HTTP-сжатия.',
            );
        }
        const controller = new AbortController(),
            abort = () => controller.abort(),
            closed = () => {
                if (!res.writableEnded) controller.abort();
            };
        req.on('aborted', abort);
        res.on('close', closed);
        try {
            if (req.aborted || res.destroyed) controller.abort();
            return await this.service.uploadArchive(req, controller.signal);
        } finally {
            req.off('aborted', abort);
            res.off('close', closed);
        }
    }
    @Post('asset-imports') async start(@Req() req: Request, @Body() body: unknown) {
        return this.service.start(await this.service.actor(req), body);
    }
    @Get('asset-imports/by-request/:key') async request(@Req() req: Request, @Param('key') key: string) {
        return this.service.request(key, await this.service.actor(req));
    }
    @Get('asset-imports/:id') async get(@Req() req: Request, @Param('id') id: string) {
        return this.service.job(id, await this.service.actor(req));
    }
    @Post('asset-imports/:id/retry') async retry(@Req() req: Request, @Param('id') id: string) {
        return this.service.retry(id, await this.service.actor(req));
    }
    @Post('asset-imports/:id/resolve') async resolve(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.resolve(id, await this.service.actor(req), body);
    }
    @Post('asset-imports/:id/cancel') async cancel(@Req() req: Request, @Param('id') id: string) {
        return this.service.cancel(id, await this.service.actor(req));
    }
}
/** Этот endpoint не публикуется wildcard proxy; native Gateway проверяет свои bootstrap/device grants. */
@Controller('internal/asset-sources')
export class AssetSupplyController {
    constructor(private readonly service: AssetSourcesService) {}
    @Get('bridge') bridge(@Req() req: Request, @Query('version') version?: string) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.service.bridgeSupply(version);
    }
    @Get('blobs/:sha') async blob(@Req() req: Request, @Param('sha') sha: string, @Res() res: Response) {
        assertInternal(req.headers['x-neurocenter-internal']);
        const file = await this.service.blobs.open(sha);
        res.status(200).setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', file.bytes);
        res.setHeader('etag', '"' + file.sha256 + '"');
        file.stream.once('error', () => res.destroy());
        res.once('close', () => file.stream.destroy());
        file.stream.pipe(res);
    }
}
