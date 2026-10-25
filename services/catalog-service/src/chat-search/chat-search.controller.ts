import {Body,Controller,Delete,Get,Param,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {ChatSearchService} from './chat-search.service';
/** Explicit paid operations are POST-only; polling/recovery never invokes a model. */
@Controller('api/projects/:projectId/chat-search')
export class ChatSearchController {
    constructor(private readonly search:ChatSearchService){}
    @Get() list(@Req() req:Request,@Param('projectId') project:string){return this.search.list(req,project);}
    @Post('index') index(@Req() req:Request,@Param('projectId') project:string,@Body() body:unknown){return this.search.create(req,project,'index',body);}
    @Post('search') query(@Req() req:Request,@Param('projectId') project:string,@Body() body:unknown){return this.search.create(req,project,'search',body);}
    @Get('jobs/:id') get(@Req() req:Request,@Param('projectId') project:string,@Param('id') id:string){return this.search.get(req,project,id);}
    @Delete('jobs/:id') cancel(@Req() req:Request,@Param('projectId') project:string,@Param('id') id:string){return this.search.cancel(req,project,id);}
}
