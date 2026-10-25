import {Body,Controller,Get,Header,Put,Query,Req} from '@nestjs/common';
import type {Request} from 'express';
import {assertInternal} from '../access/access.controller';
import type {IAccessActor} from '../access/access.model';
import {PluginAutoUpdateService} from './auto-update.service';
/** Personal policy history stays readable independently of the switch admitting new updates. */
@Controller('api/plugin-auto-updates')
export class PluginAutoUpdateController {
 constructor(private readonly updates:PluginAutoUpdateService){}
 private actor(req:Request):IAccessActor {assertInternal(req.headers['x-neurocenter-internal']);return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor']||'null'))) as IAccessActor;}
 @Get() @Header('Cache-Control','no-store') read(@Req() req:Request,@Query() query:unknown){return this.updates.read(this.actor(req),query);}
 @Put() @Header('Cache-Control','no-store') save(@Req() req:Request,@Body() body:unknown){return this.updates.save(this.actor(req),body);}
}
