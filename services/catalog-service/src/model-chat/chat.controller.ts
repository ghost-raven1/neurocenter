import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ModelChatService } from './chat.service';
import type { ChatCreateInput, ChatPreviewInput, ChatRenameInput, ChatRetryInput, ChatRevisionInput, ChatSendInput, ChatUploadInput } from './chat.types';

/** Authentication is delegated to the Gateway; service checks owner and current project rights. */
@Controller('api/model-chats')
export class ModelChatController {
    constructor(private readonly chats: ModelChatService) {}
    @Get() list(@Req() req: Request, @Query('modelId') modelId: string, @Query('projectId') projectId?: string) { return this.chats.list(req, modelId, projectId); }
    @Post() create(@Req() req: Request, @Body() body: ChatCreateInput) { return this.chats.create(req, body); }
    @Get(':id') read(@Req() req: Request, @Param('id') id: string) { return this.chats.read(req, id); }
    @Patch(':id') rename(@Req() req: Request, @Param('id') id: string, @Body() body: ChatRenameInput) { return this.chats.rename(req, id, body); }
    @Delete(':id') remove(@Req() req: Request, @Param('id') id: string, @Body() body: ChatRevisionInput) { return this.chats.remove(req, id, body); }
    @Post(':id/attachments') upload(@Req() req: Request, @Param('id') id: string, @Body() body: ChatUploadInput) { return this.connected(req, signal => this.chats.upload(req, id, body, signal)); }
    @Get(':id/attachments/:attachmentId') attachment(@Req() req: Request, @Param('id') id: string, @Param('attachmentId') attachmentId: string) { return this.chats.attachment(req, id, attachmentId); }
    @Delete(':id/attachments/:attachmentId') removeAttachment(@Req() req: Request, @Param('id') id: string, @Param('attachmentId') attachmentId: string, @Body() body: ChatRevisionInput) { return this.chats.removeAttachment(req, id, attachmentId, body); }
    @Post(':id/context-preview') preview(@Req() req: Request, @Param('id') id: string, @Body() body: ChatPreviewInput) { return this.chats.preview(req, id, body); }
    @Post(':id/turns') send(@Req() req: Request, @Param('id') id: string, @Body() body: ChatSendInput) { return this.connected(req, signal => this.chats.send(req, id, body, signal)); }
    @Post(':id/turns/:turnId/retry') retry(@Req() req: Request, @Param('id') id: string, @Param('turnId') turnId: string, @Body() body: ChatRetryInput) { return this.connected(req, signal => this.chats.retry(req, id, turnId, body, signal)); }
    @Post(':id/turns/:turnId/cancel') cancel(@Req() req: Request, @Param('id') id: string, @Param('turnId') turnId: string, @Body() body: ChatRevisionInput) { return this.chats.cancel(req, id, turnId, body); }
    @Delete(':id/turns/:turnId') removeTurn(@Req() req: Request, @Param('id') id: string, @Param('turnId') turnId: string, @Body() body: ChatRevisionInput) { return this.chats.removeTurn(req, id, turnId, body); }
    private async connected<T>(req: Request, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const abort = new AbortController(), disconnected = () => abort.abort(), closed = () => { if (!req.res?.writableEnded) abort.abort(); };
        req.on('aborted', disconnected); req.res?.on('close', closed);
        try { if (req.aborted || req.res?.destroyed) abort.abort(); return await action(abort.signal); }
        finally { req.off('aborted', disconnected); req.res?.off('close', closed); }
    }
}
