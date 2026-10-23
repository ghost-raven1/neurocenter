import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, StreamableFile, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DiscussionsService } from './discussions.service';
import { DiscussionAttachments } from './discussions.attachments';

@Controller('api/discussions')
export class DiscussionsController {
    constructor(private readonly discussions: DiscussionsService, private readonly attachments: DiscussionAttachments) {}
    @Get() list(@Req() req: Request, @Query() query: Record<string, unknown>) { return this.discussions.list(req, query); }
    @Get('comments/:id') read(@Req() req: Request, @Param('id') id: string) { return this.discussions.read(req, id); }
    @Post('comments') create(@Req() req: Request, @Body() body: unknown) { return this.discussions.create(req, body); }
    @Patch('comments/:id') update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) { return this.discussions.update(req, id, body); }
    @Delete('comments/:id') remove(@Req() req: Request, @Param('id') id: string, @Query('expectedVersion') version: unknown) { return this.discussions.remove(req, id, version); }
    @Post('attachments') async upload(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
        if (String(req.headers['content-type'] || '').split(';')[0].toLowerCase() !== 'application/octet-stream') throw new UnsupportedMediaTypeException('Передайте файл потоком application/octet-stream.');
        const controller = new AbortController(), abort = (): void => controller.abort(), closed = (): void => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', closed);
        try { if (req.aborted || res.destroyed) controller.abort(); return await this.attachments.upload(req, controller.signal); }
        finally { req.off('aborted', abort); res.off('close', closed); }
    }
    @Get('attachments/:id/content') async download(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Param('id') id: string) {
        const controller = new AbortController(), abort = (): void => controller.abort(), closed = (): void => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', closed);
        try {
            const file = await this.attachments.download(req, id, controller.signal);
            res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            return new StreamableFile(file.bytes, { type: file.mediaType, length: file.bytes.length, disposition: `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
        } finally { req.off('aborted', abort); res.off('close', closed); }
    }
    @Delete('attachments/:id') removeAttachment(@Req() req: Request, @Param('id') id: string) { return this.attachments.remove(req, id); }
}

@Controller('api/catalog-reactions')
export class CatalogReactionsController {
    constructor(private readonly discussions: DiscussionsService) {}
    @Get() read(@Req() req: Request, @Query('targetId') targetId: string) { return this.discussions.reaction(req, targetId); }
    @Put() likeTarget(@Req() req: Request, @Query('targetId') targetId: string) { return this.discussions.reaction(req, targetId, true); }
    @Delete() unlikeTarget(@Req() req: Request, @Query('targetId') targetId: string) { return this.discussions.reaction(req, targetId, false); }
    @Put(':kind/:id') like(@Req() req: Request, @Param('kind') kind: string, @Param('id') id: string) { return this.discussions.reaction(req, kind + ':' + id, true); }
    @Delete(':kind/:id') unlike(@Req() req: Request, @Param('kind') kind: string, @Param('id') id: string) { return this.discussions.reaction(req, kind + ':' + id, false); }
}
