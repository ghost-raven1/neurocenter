import {Body,Controller,Get,Param,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {LearningAnalysisService} from './learning-analysis.service';
/** Generation is an observable job; only the separate human review can promote its hypotheses. */
@Controller('api/projects/:id/learning/analyses')
export class LearningAnalysisController {
 constructor(private readonly analyses:LearningAnalysisService){}
 @Post()create(@Req()req:Request,@Param('id')id:string,@Body()body:unknown){return this.analyses.create(req,id,body);}
 @Get('requests/:key')request(@Req()req:Request,@Param('id')id:string,@Param('key')key:string){return this.analyses.byKey(req,id,key);}
 @Get(':analysisId')get(@Req()req:Request,@Param('id')id:string,@Param('analysisId')analysisId:string){return this.analyses.get(req,id,analysisId);}
}
