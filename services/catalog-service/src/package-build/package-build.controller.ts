import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import type { IAccessActor } from '../access/access.model';
import { PackageBuildService } from './package-build.service';

/** Сборка исходников отделена от установки: пользовательский проект меняет только мост. */
@Controller('api/tool-builds')
export class PackageBuildController {
    constructor(private readonly builds: PackageBuildService) {}
    private actor(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))) as IAccessActor;
    }
    @Get('npm') npm(@Req() req: Request, @Query('specifier') specifier: string, @Query('entrypoint') entrypoint?: string) { return this.builds.npm(this.actor(req), specifier, entrypoint); }
    @Get('repository') repository(@Req() req: Request, @Query('url') url: string, @Query('ref') ref?: string,
        @Query('subdirectory') subdirectory?: string, @Query('entrypoint') entrypoint?: string) {return this.builds.repositorySource(this.actor(req), {url, ref, subdirectory, entrypoint});}
    @Get('requests/:requestKey') request(@Req() req: Request, @Param('requestKey') key: string) {return this.builds.request(this.actor(req), key);}
    @Post('archive') archive(@Req() req: Request, @Body() input: unknown) {return this.builds.archiveSource(this.actor(req), input);}
    @Post() create(@Req() req: Request, @Body() input: unknown) { return this.builds.create(this.actor(req), input); }
    @Get(':id') get(@Req() req: Request, @Param('id') id: string) { return this.builds.get(this.actor(req), id); }
}
