import {Body,Controller,Delete,Get,Headers,Param,Patch,Post} from '@nestjs/common';
import {assertInternal} from '../access/access.controller';
import {BrowserAuthSessionRepository} from './browser-auth-session.repository';
import {createSessionInput,sessionHash,sessionRole} from './browser-auth-session.validation';

/** Opaque-session storage is internal-only and never authorizes a browser's grants. */
@Controller('internal/browser-auth-sessions')
export class BrowserAuthSessionController {
 constructor(private readonly sessions:BrowserAuthSessionRepository){}
 @Post()
 create(@Headers('x-neurocenter-internal') token:unknown,@Body() input:unknown){
  assertInternal(token);return this.sessions.create(createSessionInput(input));
 }
 @Get(':hash')
 find(@Headers('x-neurocenter-internal') token:unknown,@Param('hash') hash:unknown){
  assertInternal(token);return this.sessions.find(sessionHash(hash));
 }
 @Patch(':hash/selected-role')
 selectRole(@Headers('x-neurocenter-internal') token:unknown,@Param('hash') hash:unknown,@Body() input:unknown){
  assertInternal(token);return this.sessions.selectRole(sessionHash(hash),sessionRole(input));
 }
 @Delete(':hash')
 revoke(@Headers('x-neurocenter-internal') token:unknown,@Param('hash') hash:unknown){
  assertInternal(token);return this.sessions.revoke(sessionHash(hash));
 }
}
