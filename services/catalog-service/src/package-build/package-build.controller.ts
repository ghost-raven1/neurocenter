import type {RepositoryRelease} from '../../../shared/github-release-source.cjs';
import { BadRequestException, Body, Controller, Delete, Get, Head, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request,Response } from 'express';
import { assertInternal } from '../access/access.controller';
import type { IAccessActor } from '../access/access.model';
import { PackageBuildService } from './package-build.service';
import {sendToolSupply,supplyFailure} from './supply-response';
import {serializeAsset} from '@neurocenter/asset-contract';

/** Сборка исходников отделена от установки: пользовательский проект меняет только мост. */
@Controller('api/tool-builds')
export class PackageBuildController {
    constructor(private readonly builds: PackageBuildService) {}
    private actor(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))) as IAccessActor;
    }
    @Get('npm') npm(@Req() req: Request, @Query('specifier') specifier: string, @Query('entrypoint') entrypoint?: string) { return this.builds.npm(this.actor(req), specifier, entrypoint); }
    @Get('connectors/codex') codexConnector(@Req() req:Request){return this.builds.codexConnector(this.actor(req));}
    @Get('repository') repository(@Req() req: Request, @Query('url') url: string, @Query('ref') ref?: string,
        @Query('subdirectory') subdirectory?: string, @Query('entrypoint') entrypoint?: string, @Query('release') release?: string) {
        let parsed: unknown;
        if (release !== undefined) {try {parsed = JSON.parse(release);} catch {throw new BadRequestException('Некорректные поля релиза GitHub.');}}
        return this.builds.repositorySource(this.actor(req), {url, ref, subdirectory, entrypoint, ...(parsed !== undefined ? {release: parsed as RepositoryRelease} : {})});
    }
    @Get('requests/:requestKey') request(@Req() req: Request, @Param('requestKey') key: string) {return this.builds.request(this.actor(req), key);}
    @Get('publication-target') publicationTarget(@Req() req:Request,@Query('kind') kind:string,@Query('catalogId') id:string){return this.builds.publicationTarget(this.actor(req),kind,id);}
    @Delete('requests/:requestKey') cancelRequest(@Req() req:Request,@Param('requestKey') key:string){return this.builds.cancelRequest(this.actor(req),key);}
    @Post('archive') archive(@Req() req: Request, @Body() input: unknown) {return this.builds.archiveSource(this.actor(req), input);}
    @Post('imports') async importAsset(@Req() req:Request,@Body() input:unknown,@Res({passthrough:true}) res:Response){
        const abort=new AbortController(),disconnected=()=>{if(!res.writableEnded)abort.abort();};
        req.on('aborted',disconnected);res.on('close',disconnected);
        try{if(req.aborted||res.destroyed)abort.abort();return await this.builds.importAsset(this.actor(req),input,abort.signal);}
        finally{req.off('aborted',disconnected);res.off('close',disconnected);}
    }
    @Get(':id/asset') async asset(@Req() req:Request,@Param('id') id:string,@Res() res:Response){const asset=await this.builds.exportAsset(this.actor(req),id);res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.send(serializeAsset(asset));}
    @Head(':id/supply') async supplyReady(@Req() req:Request,@Param('id') id:string,@Res() res:Response){try{await this.builds.checkSupply(this.actor(req),id);res.setHeader('Cache-Control','no-store');res.status(204).end();}catch(error){supplyFailure(res,error);}}
    @Get(':id/supply') async supply(@Req() req:Request,@Param('id') id:string,@Res() res:Response){const actor=this.actor(req);await sendToolSupply(req,res,()=>this.builds.requireMain(actor),signal=>this.builds.exportSupply(actor,id,signal));}
    @Post() create(@Req() req: Request, @Body() input: unknown) { return this.builds.create(this.actor(req), input); }
    @Get(':id') get(@Req() req: Request, @Param('id') id: string) { return this.builds.get(this.actor(req), id); }
    @Delete(':id') cancel(@Req() req:Request,@Param('id') id:string){return this.builds.cancel(this.actor(req),id);}
}
