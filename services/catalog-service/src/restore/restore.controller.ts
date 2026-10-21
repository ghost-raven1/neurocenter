import {Body,Controller,Get,HttpCode,Param,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {RestoreService} from './restore.service';

/** Проверка, явное подтверждение и история принадлежат действующему главному администратору. */
@Controller('api/maintenance/restore')
export class RestoreController {
 constructor(private readonly service:RestoreService){}
 @Get()async status(@Req() req:Request){return this.service.status(await this.service.actor(req));}
 @Post('previews')@HttpCode(202)async preview(@Req() req:Request,@Body() input:unknown){return this.service.preview(await this.service.actor(req),input);}
 @Post()@HttpCode(202)async restore(@Req() req:Request,@Body() input:unknown){return this.service.restore(await this.service.actor(req),input);}
 @Get('requests/:key')async request(@Req() req:Request,@Param('key') key:string){return this.service.get(await this.service.actor(req),key,true);}
 @Post('requests/:key/cancel')async cancelRequest(@Req() req:Request,@Param('key') key:string){return this.service.cancelRequest(await this.service.actor(req),key);}
 @Get('jobs/:id')async get(@Req() req:Request,@Param('id') id:string){return this.service.get(await this.service.actor(req),id);}
 @Post('jobs/:id/cancel')async cancel(@Req() req:Request,@Param('id') id:string){return this.service.cancel(await this.service.actor(req),id);}
}

/** Gateway не проксирует internal route; токен runner не даёт произвольного SQL или shell. */
@Controller('internal/maintenance/restore')
export class RestoreRunnerController {
 constructor(private readonly service:RestoreService){}
 @Post('report')async report(@Req() req:Request,@Body() input:unknown){this.service.assertRunner(req.headers['x-neurocenter-restore']);return this.service.report(input);}
 @Post('claim')async claim(@Req() req:Request,@Body() input:unknown){this.service.assertRunner(req.headers['x-neurocenter-restore']);return {job:await this.service.claim(input)};}
 @Post('jobs/:id/pulse')async pulse(@Req() req:Request,@Param('id') id:string,@Body() input:unknown){this.service.assertRunner(req.headers['x-neurocenter-restore']);return this.service.pulse(id,input);}
 @Post('jobs/:id/complete')async complete(@Req() req:Request,@Param('id') id:string,@Body() input:unknown){this.service.assertRunner(req.headers['x-neurocenter-restore']);return this.service.complete(id,input);}
}
