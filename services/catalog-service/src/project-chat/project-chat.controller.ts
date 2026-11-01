import { Body, Controller, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ProjectChatService } from './project-chat.service';
import type { IProjectChatActivityInput } from '../chat-activity/chat-activity.interfaces';
import type {
    IProjectChatCancelInput,
    IProjectChatDetail,
    IProjectChatHistory,
    IProjectChatParticipantsInput,
    IProjectChatReceipt,
    IProjectChatRetryInput,
    IProjectChatSendInput,
    IProjectChatCreateRoomInput,
    IProjectChatUpdateRoomInput,
    IProjectChatRoomSummary,
    IProjectChatRooms,
} from './project-chat.interfaces';
/** Shared project messages acknowledge storage before the independent agent queue executes. */
@Controller('api/projects/:projectId/team-chat')
export class ProjectChatController {
    constructor(private readonly chats: ProjectChatService) {}
    @Get() read(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Query('watch') watch?: string,
    ): Promise<IProjectChatDetail> {
        return this.chats.read(req, projectId, watch);
    }
    @Get('activity') activity(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Query('messageIds') messageIds?: string,
    ) {
        return this.chats.readActivity(req, projectId, messageIds);
    }
    @Put('activity') updateActivity(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Body() body: IProjectChatActivityInput,
    ) {
        return this.chats.updateActivity(req, projectId, body);
    }
    @Get('history') history(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Query('before') before?: string,
        @Query('limit') limit?: string,
    ): Promise<IProjectChatHistory> {
        return this.chats.history(req, projectId, before, limit);
    }
    @Put('participants') participants(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Body() body: IProjectChatParticipantsInput,
    ): Promise<IProjectChatDetail> {
        return this.chats.participants(req, projectId, body);
    }
    @Post('messages') send(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Body() body: IProjectChatSendInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.send(req, projectId, body);
    }
    @Get('messages/:messageId/workflows') workflows(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('messageId') messageId: string,
        @Query('before') before?: string,
        @Query('limit') limit?: string,
    ) {
        return this.chats.methodWorkflows(req, projectId, messageId, before, limit);
    }
    @Post('messages/:messageId/retry') retry(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('messageId') messageId: string,
        @Body() body: IProjectChatRetryInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.retry(req, projectId, messageId, body);
    }
    @Post('messages/:messageId/cancel') cancel(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('messageId') messageId: string,
        @Body() body: IProjectChatCancelInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.cancel(req, projectId, messageId, body);
    }
    @Get('rooms') rooms(@Req() req: Request, @Param('projectId') projectId: string): Promise<IProjectChatRooms> {
        return this.chats.rooms(req, projectId);
    }
    @Post('rooms') createRoom(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Body() body: IProjectChatCreateRoomInput,
    ): Promise<IProjectChatRoomSummary> {
        return this.chats.createRoom(req, projectId, body);
    }
    @Get('rooms/:roomId') readRoom(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Query('watch') watch?: string,
    ): Promise<IProjectChatDetail> {
        return this.chats.read(req, projectId, watch, roomId);
    }
    @Get('rooms/:roomId/activity') roomActivity(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Query('messageIds') messageIds?: string,
    ) {
        return this.chats.readActivity(req, projectId, messageIds, roomId);
    }
    @Put('rooms/:roomId/activity') updateRoomActivity(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Body() body: IProjectChatActivityInput,
    ) {
        return this.chats.updateActivity(req, projectId, body, roomId);
    }
    @Put('rooms/:roomId') updateRoom(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Body() body: IProjectChatUpdateRoomInput,
    ): Promise<IProjectChatRoomSummary> {
        return this.chats.updateRoom(req, projectId, roomId, body);
    }
    @Get('rooms/:roomId/history') roomHistory(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Query('before') before?: string,
        @Query('limit') limit?: string,
    ): Promise<IProjectChatHistory> {
        return this.chats.history(req, projectId, before, limit, roomId);
    }
    @Put('rooms/:roomId/participants') roomParticipants(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Body() body: IProjectChatParticipantsInput,
    ): Promise<IProjectChatDetail> {
        return this.chats.participants(req, projectId, body, roomId);
    }
    @Post('rooms/:roomId/messages') roomSend(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Body() body: IProjectChatSendInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.send(req, projectId, body, roomId);
    }
    @Get('rooms/:roomId/messages/:messageId/workflows') roomWorkflows(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Param('messageId') messageId: string,
        @Query('before') before?: string,
        @Query('limit') limit?: string,
    ) {
        return this.chats.methodWorkflows(req, projectId, messageId, before, limit, roomId);
    }
    @Post('rooms/:roomId/messages/:messageId/retry') roomRetry(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Param('messageId') messageId: string,
        @Body() body: IProjectChatRetryInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.retry(req, projectId, messageId, body, roomId);
    }
    @Post('rooms/:roomId/messages/:messageId/cancel') roomCancel(
        @Req() req: Request,
        @Param('projectId') projectId: string,
        @Param('roomId') roomId: string,
        @Param('messageId') messageId: string,
        @Body() body: IProjectChatCancelInput,
    ): Promise<IProjectChatReceipt> {
        return this.chats.cancel(req, projectId, messageId, body, roomId);
    }
}
