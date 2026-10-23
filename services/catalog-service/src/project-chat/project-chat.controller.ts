import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ProjectChatService } from './project-chat.service';
import type { ProjectChatCancelInput, ProjectChatDetail, ProjectChatHistory, ProjectChatParticipantsInput, ProjectChatReceipt, ProjectChatRetryInput, ProjectChatSendInput } from './project-chat.types';
/** Shared project messages acknowledge storage before the independent agent queue executes. */
@Controller('api/projects/:projectId/team-chat')
export class ProjectChatController {
    constructor(private readonly chats: ProjectChatService) {}
    @Get() read(@Req() req: Request, @Param('projectId') projectId: string, @Query('watch') watch?: string): Promise<ProjectChatDetail> { return this.chats.read(req, projectId, watch); }
    @Get('history') history(@Req() req: Request, @Param('projectId') projectId: string, @Query('before') before?: string, @Query('limit') limit?: string): Promise<ProjectChatHistory> { return this.chats.history(req, projectId, before, limit); }
    @Put('participants') participants(@Req() req: Request, @Param('projectId') projectId: string, @Body() body: ProjectChatParticipantsInput): Promise<ProjectChatDetail> { return this.chats.participants(req, projectId, body); }
    @Post('messages') send(@Req() req: Request, @Param('projectId') projectId: string, @Body() body: ProjectChatSendInput): Promise<ProjectChatReceipt> { return this.chats.send(req, projectId, body); }
    @Post('messages/:messageId/retry') retry(@Req() req: Request, @Param('projectId') projectId: string, @Param('messageId') messageId: string, @Body() body: ProjectChatRetryInput): Promise<ProjectChatReceipt> { return this.chats.retry(req, projectId, messageId, body); }
    @Post('messages/:messageId/cancel') cancel(@Req() req: Request, @Param('projectId') projectId: string, @Param('messageId') messageId: string, @Body() body: ProjectChatCancelInput): Promise<ProjectChatReceipt> { return this.chats.cancel(req, projectId, messageId, body); }
}
