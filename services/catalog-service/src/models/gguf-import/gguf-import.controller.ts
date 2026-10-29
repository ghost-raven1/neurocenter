import {BadRequestException,Body,Controller,Delete,Get,Param,Post,Put,Req,Res,UnsupportedMediaTypeException} from '@nestjs/common';
import type {Request,Response} from 'express';
import {assertInternal} from '../../access/access.controller';
import type {IAccessActor} from '../../access/access.model';
import {GgufImportService} from './gguf-import.service';

/** The Gateway supplies identity; the import owner rechecks current Main-admin rights. */
@Controller('api/models/gguf-imports')
export class GgufImportController {
 constructor(private readonly imports:GgufImportService){}
 private actor(req:Request):IAccessActor{assertInternal(req.headers['x-neurocenter-internal']);try{return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor']||'null'))) as IAccessActor;}catch{throw new BadRequestException('Не подтверждён владелец импорта.');}}
 @Get('limits') limits(@Req() req:Request){return this.imports.limits(this.actor(req));}
 @Post() create(@Req() req:Request,@Body() body:unknown){return this.imports.create(this.actor(req),body);}
 @Get('requests/:key') lookup(@Req() req:Request,@Param('key') key:string){return this.imports.lookup(this.actor(req),key);}
 @Get(':id') get(@Req() req:Request,@Param('id') id:string){return this.imports.get(this.actor(req),id);}
 @Delete(':id') cancel(@Req() req:Request,@Param('id') id:string){return this.imports.cancel(this.actor(req),id);}
 @Post(':id/accept') accept(@Req() req:Request,@Param('id') id:string,@Body() body:unknown){return this.imports.accept(this.actor(req),id,body);}
 @Put(':id/content') async content(@Req() req:Request,@Res({passthrough:true}) res:Response,@Param('id') id:string){
  res.setHeader('Cache-Control','no-store');res.setHeader('Connection','close');
  if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw new UnsupportedMediaTypeException('Передайте GGUF потоком application/octet-stream.');
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)controller.abort();};req.on('aborted',abort);res.on('close',closed);
  try{if(req.aborted||res.destroyed)controller.abort();return await this.imports.content(this.actor(req),id,req,req.headers['content-length'],controller.signal);}finally{req.off('aborted',abort);res.off('close',closed);}
 }
}
