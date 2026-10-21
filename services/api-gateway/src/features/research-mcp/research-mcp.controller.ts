import {Body,Controller,ForbiddenException,Headers,HttpException,Inject,Post,Req,Res,ServiceUnavailableException} from '@nestjs/common';
import {timingSafeEqual} from 'node:crypto';
import type {Request,Response} from 'express';
import {FeatureFlagError,requireFeaturesEnabled} from '../../../../shared/feature-client.cjs';
import type {McpHostService} from '../mcp-host/host';
import {researchPackage} from './research-package';
import {researchArguments,researchOutput,researchTools} from './research-tools';

/** Only Catalog's freshly authorized project executor may request a pinned MCP through Gateway. */
@Controller('internal/research-mcp')
export class ResearchMcpController {
    constructor(@Inject('MCP_HOST') private readonly host:McpHostService){}
    @Post('list') list(@Headers('x-neurocenter-internal') token:string,@Body() body:unknown,@Req() req:Request,@Res({passthrough:true}) res:Response){
        return this.execute(token,body,req,res,async(claim,signal)=>researchTools(await this.host.researchTools(claim,signal)));
    }
    @Post('call') call(@Headers('x-neurocenter-internal') token:string,@Body() body:unknown,@Req() req:Request,@Res({passthrough:true}) res:Response){
        return this.execute(token,body,req,res,async(claim,signal)=>{
            const input=body as Record<string,unknown>,call=researchArguments(input.name,input.arguments);
            researchTools(await this.host.researchTools(claim,signal));
            await requireFeaturesEnabled(['research_tools','tool_catalog'],process.env,globalThis.fetch,signal);
            return researchOutput(await this.host.researchCall(claim,call.name,call.arguments,signal));
        });
    }

    private async execute<T>(token:string,body:unknown,req:Request,res:Response,action:(claim:ReturnType<typeof researchPackage>,signal:AbortSignal)=>Promise<T>):Promise<T>{
        const expected=process.env.NEUROCENTER_INTERNAL_TOKEN||'';
        if(!expected||typeof token!=='string'||Buffer.byteLength(expected)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(expected),Buffer.from(token)))throw new ForbiddenException();
        const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort(new Error('RESEARCH_CANCELLED'));};
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(45000)]);
        req.once('aborted',abort);res.once('close',abort);
        try{
            signal.throwIfAborted();await requireFeaturesEnabled(['research_tools','tool_catalog'],process.env,globalThis.fetch,signal);
            const pkg=body&&typeof body==='object'&&!Array.isArray(body)?(body as {pkg?:unknown}).pkg:undefined;
            const claim=researchPackage(pkg);
            try{return await action(claim,signal);}finally{await this.host.closeResearchSession?.(claim);}
        }catch(error){
            if(error instanceof FeatureFlagError)throw new HttpException({statusCode:error.status,code:error.code,message:error.message,feature:error.feature,blockedBy:error.blockedBy},error.status);
            if(error instanceof HttpException)throw error;
            throw new ServiceUnavailableException(signal.aborted?'Исследование отменено или превысило время ожидания.':'Поисковый MCP временно недоступен.');
        }finally{req.off('aborted',abort);res.off('close',abort);}
    }
}
