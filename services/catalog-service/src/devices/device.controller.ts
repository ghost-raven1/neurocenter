import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    Param,
    Query,
    Post,
    Req,
    Res,
    StreamableFile,
    ConflictException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertInternal } from '../access/access.controller';
import type { IAccessActor } from '../access/access.model';
import { DeviceStore } from './device-store';
import { DeviceJobs, JobInput } from './device-jobs';
import {DeviceInstallations} from './device-installations';
import { completeDeviceJob, type DeviceCompletion } from './device-completion';
import { RuntimeArtifacts } from '../runtime-artifacts/runtime-artifacts';
import { approvedRuntimeArtifact } from './runtime-job-artifact';
import {DeviceEmbeddingService} from '../models/device-embedding.service';

/** Browser управляет только своими устройствами; channel принимает только секрет привязанного MCP. */
@Controller()
export class DeviceController {
    constructor(
        private readonly devices: DeviceStore,
        private readonly jobs: DeviceJobs,
        private readonly installations:DeviceInstallations,
        private readonly runtimeArtifacts:RuntimeArtifacts,
        private readonly embedding:DeviceEmbeddingService,
    ) {}
    private actor(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        return JSON.parse(
            decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')),
        ) as IAccessActor;
    }
    private device(req: Request) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.devices.identity(
            String(req.headers.authorization || '').replace(/^Bearer /, ''),
        );
    }
    @Get('api/devices') list(@Req() req: Request) {
        return this.devices.list(this.actor(req));
    }
    @Delete('api/devices/:id') revoke(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.devices.revoke(this.actor(req), id);
    }
    @Get('api/device-pairs/:code') info(
        @Req() req: Request,
        @Param('code') code: string,
    ) {
        return this.devices.pairInfo(code,this.actor(req));
    }
    @Post('api/device-pairs/:code/approve') approve(
        @Req() req: Request,
        @Param('code') code: string,
    ) {
        return this.devices.approve(this.actor(req), code);
    }
    @Get('api/device-jobs') listJobs(@Req() req: Request) {
        return this.jobs.list(this.actor(req));
    }
    @Get('api/device-installations') listInstallations(@Req() req:Request){return this.installations.list(this.actor(req));}
    @Post('api/device-jobs') create(
        @Req() req: Request,
        @Body() input: JobInput,
    ) {
        return this.jobs.create(this.actor(req), input);
    }
    @Delete('api/device-jobs/:id') cancel(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.jobs.cancel(this.actor(req), id);
    }
    @Post('api/device-jobs/:id/retry') retry(@Req() req:Request,@Param('id') id:string,@Body() body:{requestKey?:string}){return this.jobs.retry(this.actor(req),id,body?.requestKey||'');}
    @Post('internal/device-channel/pair/start') start(
        @Headers('x-neurocenter-internal') token: string,
        @Body() input: Parameters<DeviceStore['start']>[0],
        @Headers('authorization') authorization?: string,
    ) {
        assertInternal(token);
        return this.devices.start(input, authorization?.replace(/^Bearer /, ''));
    }
    @Post('internal/device-channel/pair/poll') poll(
        @Headers('x-neurocenter-internal') token: string,
        @Body() input: { deviceCode?: string } | null,
    ) {
        assertInternal(token);
        return this.devices.poll(input?.deviceCode || '');
    }
    @Post('internal/device-channel/identity') async identity(
        @Req() req: Request,
    ) {
        const device = await this.device(req);
        return { id: device.id, email: device.email, role: device.role };
    }
    @Post('internal/device-channel/heartbeat') async heartbeat(
        @Req() req: Request,
        @Body() input: Record<string, unknown>,
    ) {
        return this.devices.heartbeat(await this.device(req), input);
    }
    @Post('internal/device-channel/jobs/claim') async claim(
        @Req() req: Request,
    ) {
        return this.jobs.claim(await this.device(req));
    }
    @Post('internal/device-channel/worker/pause') async pause(@Req() req: Request) {
        return this.devices.pause(await this.device(req));
    }
    @Post('internal/device-channel/worker/resume') async resume(@Req() req: Request) {
        return this.devices.resume(await this.device(req));
    }
    @Post('internal/device-channel/jobs/:id/authorize') async authorize(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() input: { lease: string },
        @Query('phase') phase?:string,
    ) {
        return this.jobs.authorize(await this.device(req), id, input.lease,phase==='snapshot-receipt'?{snapshotReceipt:true}:undefined);
    }
    @Post('internal/device-channel/agents/compile') async compileAgents(@Req() req:Request,@Body() input:unknown){return this.jobs.compileAgents(await this.device(req),input);}
    @Post('internal/device-channel/configuration-authorize') async configurationAuthorize(@Req() req:Request,@Body() input:unknown){
        return this.jobs.authorizeConfiguration(await this.device(req),input);
    }
    @Post('internal/device-channel/embedding/context') async embeddingContext(@Req() req:Request,@Body() input:unknown){
        return this.embedding.context(await this.device(req),input);
    }
    @Post('internal/device-channel/embedding') async embeddings(@Req() req:Request,@Body() input:unknown){
        const device=await this.device(req);const abort=new AbortController();
        const disconnected=()=>abort.abort();const closed=()=>{if(!req.res?.writableEnded)abort.abort();};
        req.on('aborted',disconnected);req.res?.on('close',closed);
        try{if(req.aborted||req.res?.destroyed)abort.abort();return await this.embedding.embed(device,input,abort.signal);}
        finally{req.removeListener('aborted',disconnected);req.res?.removeListener('close',closed);}
    }
    /** Только архив одобренной установки или явно подтверждённого восстановления runtime этого устройства. */
    @Get('internal/device-channel/jobs/:id/runtime/:sha256') async runtimeArtifact(@Req() req:Request,@Res({passthrough:true})res:Response,@Param('id')id:string,@Param('sha256')sha256:string){
        const device=await this.device(req);const lease=String(req.headers['x-neurocenter-job-lease']??'');
        if(!/^[a-f0-9]{64}$/.test(sha256))throw new ConflictException('Артефакт не входит в задание.');
        await this.jobs.authorize(device,id,lease);
        const descriptor=await approvedRuntimeArtifact(this.devices.pool,device.id,id,lease,sha256);
        const opened=await this.runtimeArtifacts.open(sha256);
        if(opened.bytes!==descriptor.compressedBytes){opened.stream.destroy();throw new ConflictException('Размер артефакта не соответствует комплекту.');}
        res.setHeader('cache-control','no-store');return new StreamableFile(opened.stream,{type:'application/gzip',length:opened.bytes});
    }
    @Post('internal/device-channel/jobs/:id/progress') async progress(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() input: Parameters<DeviceJobs['update']>[2],
    ) {
        return this.jobs.update(await this.device(req), id, input);
    }
    @Post('internal/device-channel/jobs/:id/complete') async complete(
        @Req() req: Request, @Param('id') id: string, @Body() input: DeviceCompletion,
    ) {
        const device = await this.device(req);
        return completeDeviceJob(this.devices.pool, device.id, id, input);
    }
}
