import {Body,Controller,Get,Param,Post,Req,Res} from '@nestjs/common';
import type {Request,Response} from 'express';
import {SnapshotService} from './snapshot.service';
import {SnapshotVerifier} from './snapshot-verifier';
import {SnapshotGarbageCollector} from './snapshot-gc';

/** Closed executor channel is never routed by the public Gateway. */
@Controller('internal/project-snapshots/verifier')
export class SnapshotVerifierController {
    private readonly verifier:SnapshotVerifier;
    private readonly garbageCollector:SnapshotGarbageCollector;
    constructor(private readonly service:SnapshotService){this.verifier=new SnapshotVerifier(service);this.garbageCollector=new SnapshotGarbageCollector(service);}
    @Get('ready') async ready(@Req() req:Request){this.verifier.authenticate(req);return {ok:!!(await this.service.pool.query("SELECT 1 FROM project_snapshot_verifiers WHERE last_seen>now()-interval '60 seconds' AND ($1::text IS NULL OR image_digest=$1) LIMIT 1",[process.env.SNAPSHOT_VERIFIER_IMAGE_DIGEST??null])).rowCount};}
    @Post('gc') collect(@Req() req:Request){this.verifier.authenticate(req);return this.garbageCollector.collect();}
    @Post('claim') claim(@Req() req:Request,@Body() body:Parameters<SnapshotVerifier['claim']>[0]){this.verifier.authenticate(req);return this.verifier.claim(body);}
    @Post(':id/renew') renew(@Req() req:Request,@Param('id') id:string,@Body() body:{workerId:string}){this.verifier.authenticate(req);return this.verifier.renew(id,body?.workerId);}
    @Get(':id/:worker/blobs/:sha') async blob(@Req() req:Request,@Res() res:Response,@Param('id') id:string,@Param('worker') worker:string,@Param('sha') sha:string){
        this.verifier.authenticate(req);await this.service.binary(res,()=>this.verifier.block(id,worker,sha));
    }
    @Post(':id/complete') complete(@Req() req:Request,@Param('id') id:string,@Body() body:{workerId:string;result:unknown}){this.verifier.authenticate(req);return this.verifier.complete(id,body?.workerId,body?.result);}
    @Post(':id/reject') reject(@Req() req:Request,@Param('id') id:string,@Body() body:{workerId:string;reason:unknown}){this.verifier.authenticate(req);return this.verifier.reject(id,body?.workerId,body?.reason);}
}
