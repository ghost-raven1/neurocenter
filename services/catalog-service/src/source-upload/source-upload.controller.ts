import {BadRequestException,Body,Controller,Delete,Get,Param,Post,Put,Req,Res,UnsupportedMediaTypeException} from '@nestjs/common';
import type {Request,Response} from 'express';
import {assertInternal} from '../access/access.controller';
import type {IAccessActor} from '../access/access.model';
import {SourceUploadService} from './source-upload.service';

/** Binary data plane and durable control plane both require the authenticated Gateway actor. */
@Controller('api/tool-builds/uploads')
export class SourceUploadController{
 constructor(private readonly uploads:SourceUploadService){}
 private actor(req:Request):IAccessActor{
  assertInternal(req.headers['x-neurocenter-internal']);
  try{return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor']||'null'))) as IAccessActor;}catch{throw new BadRequestException('Не подтверждён владелец загрузки.');}
 }
 @Post() create(@Req() req:Request,@Body() body:unknown){return this.uploads.create(this.actor(req),body);}
 @Get('requests/:key') lookup(@Req() req:Request,@Param('key') key:string){return this.uploads.lookup(this.actor(req),key);}
 @Delete('requests/:key') cancelRequest(@Req() req:Request,@Param('key') key:string){return this.uploads.cancelRequest(this.actor(req),key);}
 @Get(':id') get(@Req() req:Request,@Param('id') id:string){return this.uploads.get(this.actor(req),id);}
 @Delete(':id') cancel(@Req() req:Request,@Param('id') id:string){return this.uploads.cancel(this.actor(req),id);}
 @Put(':id/content') async content(@Req() req:Request,@Res({passthrough:true}) res:Response,@Param('id') id:string){
  if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/octet-stream'){res.setHeader('Connection','close');throw new UnsupportedMediaTypeException('Нужен поток application/octet-stream.');}
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)controller.abort();};
  req.on('aborted',abort);res.on('close',closed);
  try{if(req.aborted||res.destroyed)controller.abort();return await this.uploads.content(this.actor(req),id,req,req.headers['content-length'],controller.signal);}
  finally{req.off('aborted',abort);res.off('close',closed);}
 }
}
