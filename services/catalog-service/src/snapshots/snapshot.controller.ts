import {BadRequestException,Body,Controller,Get,Param,Post,Put,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import {SnapshotService} from './snapshot.service';
import type {SnapshotCreate} from './snapshot-types';

/** Metadata and bounded raw chunks pass through the same authorized Gateway. */
@Controller('api/projects/:id')
export class ProjectSnapshotsController {
    constructor(private readonly snapshots:SnapshotService){}
    @Get('versions') list(@Req() req:Request,@Param('id') id:string){return this.snapshots.repository.list(id,this.snapshots.actor(req));}
    @Get('versions/capabilities') async capabilities(@Req() req:Request,@Param('id') id:string){
        await this.snapshots.repository.transaction(id,this.snapshots.actor(req),1,async()=>undefined);return this.snapshots.capabilities();
    }
    @Post('versions') create(@Req() req:Request,@Param('id') id:string,@Body() body:SnapshotCreate){return this.snapshots.create(req,id,body);}
    @Get('versions/requests/:key') async lookup(@Req() req:Request,@Res() res:Response,@Param('id') id:string,@Param('key') key:string){res.json(await this.snapshots.repository.lookup(id,this.snapshots.actor(req),key));}
    @Get('versions/commands/:key') async lookupCommand(@Req() req:Request,@Res() res:Response,@Param('id') id:string,@Param('key') key:string){res.json(await this.snapshots.repository.lookupCommand(id,this.snapshots.actor(req),key));}
    @Post('versions/commands/:key/cancel') cancelCommand(@Req() req:Request,@Param('id') id:string,@Param('key') key:string){return this.snapshots.repository.cancelCommand(id,this.snapshots.actor(req),key);}
    @Post('versions/requests/:key/cancel') async cancelRequest(@Req() req:Request,@Param('id') id:string,@Param('key') key:string,@Body() body:SnapshotCreate){
        if(body?.requestKey!==key)throw new BadRequestException('UUID запроса не совпадает.');
        return this.snapshots.repository.cancelRequest(id,this.snapshots.actor(req),body);
    }
    @Get('versions/:sid/manifest') manifest(@Req() req:Request,@Param('id') id:string,@Param('sid') sid:string){return this.snapshots.repository.manifest(id,sid,this.snapshots.actor(req));}
    @Get('profiles') profiles(@Req() req:Request,@Param('id') id:string){return this.snapshots.commands.profiles(id,this.snapshots.actor(req));}
    @Get('profiles/:profileId') capsule(@Req() req:Request,@Param('id') id:string,@Param('profileId') profile:string){return this.snapshots.commands.capsule(id,profile,this.snapshots.actor(req));}
    @Get('snapshot-uploads/:sid/status') async status(@Req() req:Request,@Param('id') id:string,@Param('sid') sid:string){
        const {row}=await this.snapshots.publication(req,id,sid,true);
        return {snapshotId:row.id,status:row.upload_completed_at?'UPLOADED':row.status,manifestSha256:row.manifest_sha256,bytes:Number(row.total_bytes),fileCount:row.manifest?.files.length??0,tableCount:row.manifest?.tables.length??0};
    }
    @Post('snapshot-uploads/:sid/manifest') async begin(@Req() req:Request,@Param('id') id:string,@Param('sid') sid:string,@Body() body:unknown){
        const {actor}=await this.snapshots.publication(req,id,sid);return this.snapshots.repository.beginManifest(id,sid,actor,body);
    }
    @Put('snapshot-uploads/:sid/blobs/:sha') async upload(@Req() req:Request,@Res() res:Response,@Param('id') id:string,@Param('sid') sid:string,@Param('sha') sha:string){
        res.setHeader('Connection','close');res.json(await this.snapshots.upload(req,id,sid,sha));
    }
    @Post('snapshot-uploads/:sid/complete') async complete(@Req() req:Request,@Param('id') id:string,@Param('sid') sid:string,@Body() body:{manifestSha256:string}){
        const {actor}=await this.snapshots.publication(req,id,sid);return this.snapshots.repository.finishUpload(id,sid,actor,body?.manifestSha256);
    }
    @Get('versions/:sid/blobs/:sha') async download(@Req() req:Request,@Res() res:Response,@Param('id') id:string,@Param('sid') sid:string,@Param('sha') sha:string){
        await this.snapshots.binary(res,()=>this.snapshots.download(req,id,sid,sha));
    }
}
