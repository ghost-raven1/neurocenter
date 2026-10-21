import {Body,Controller,Get,Param,Post,Query,Req} from '@nestjs/common';
import type {Request} from 'express';
import {LearningService} from './learning.service';
import type {LearningExperienceInput,LearningHypothesisInput,LearningCheckInput,LearningCandidateInput,LearningCandidateActionInput} from '../../../shared/project-learning.cjs';

@Controller('api/projects/:id/learning')
export class LearningController {
    constructor(private readonly learning:LearningService){}
    @Get()overview(@Req()req:Request,@Param('id')id:string){return this.learning.overview(req,id);}
    @Get('context')context(@Req()req:Request,@Param('id')id:string){return this.learning.context(req,id);}
    @Get('history')history(@Req()req:Request,@Param('id')id:string,@Query('beforeRevision')before?:string){return this.learning.history(req,id,before);}
    @Get('requests/:key')request(@Req()req:Request,@Param('id')id:string,@Param('key')key:string){return this.learning.request(req,id,key);}
    @Get('experiences')experiences(@Req()req:Request,@Param('id')id:string,@Query('before')before?:string){return this.learning.page(req,id,'experiences',before);}
    @Get('hypotheses')hypotheses(@Req()req:Request,@Param('id')id:string,@Query('before')before?:string){return this.learning.page(req,id,'hypotheses',before);}
    @Get('candidates')candidates(@Req()req:Request,@Param('id')id:string,@Query('before')before?:string){return this.learning.page(req,id,'candidates',before);}
    @Get('experiences/:recordId')experienceDetail(@Req()req:Request,@Param('id')id:string,@Param('recordId')recordId:string){return this.learning.detail(req,id,'experiences',recordId);}
    @Get('hypotheses/:recordId')hypothesisDetail(@Req()req:Request,@Param('id')id:string,@Param('recordId')recordId:string){return this.learning.detail(req,id,'hypotheses',recordId);}
    @Get('candidates/:recordId')candidateDetail(@Req()req:Request,@Param('id')id:string,@Param('recordId')recordId:string){return this.learning.detail(req,id,'candidates',recordId);}
    @Get('hypotheses/:hypothesisId/checks')checks(@Req()req:Request,@Param('id')id:string,@Param('hypothesisId')hypothesisId:string,@Query('before')before?:string){return this.learning.checks(req,id,hypothesisId,before);}
    @Get('hypotheses/:hypothesisId/checks/:checkId')checkDetail(@Req()req:Request,@Param('id')id:string,@Param('hypothesisId')hypothesisId:string,@Param('checkId')checkId:string){return this.learning.checkDetail(req,id,hypothesisId,checkId);}
    @Post('experiences')experience(@Req()req:Request,@Param('id')id:string,@Body()body:LearningExperienceInput){return this.learning.recordExperience(req,id,body);}
    @Post('hypotheses')hypothesis(@Req()req:Request,@Param('id')id:string,@Body()body:LearningHypothesisInput){return this.learning.proposeHypothesis(req,id,body);}
    @Post('hypotheses/:hypothesisId/checks')check(@Req()req:Request,@Param('id')id:string,@Param('hypothesisId')hypothesisId:string,@Body()body:LearningCheckInput){return this.learning.checkHypothesis(req,id,hypothesisId,body);}
    @Post('candidates')candidate(@Req()req:Request,@Param('id')id:string,@Body()body:LearningCandidateInput){return this.learning.proposeCandidate(req,id,body);}
    @Post('candidates/:candidateId/approve')approve(@Req()req:Request,@Param('id')id:string,@Param('candidateId')candidateId:string,@Body()body:LearningCandidateActionInput){return this.learning.candidateAction(req,id,candidateId,body,'approve');}
    @Post('candidates/:candidateId/reject')reject(@Req()req:Request,@Param('id')id:string,@Param('candidateId')candidateId:string,@Body()body:LearningCandidateActionInput){return this.learning.candidateAction(req,id,candidateId,body,'reject');}
    @Post('candidates/:candidateId/revoke')revoke(@Req()req:Request,@Param('id')id:string,@Param('candidateId')candidateId:string,@Body()body:LearningCandidateActionInput){return this.learning.candidateAction(req,id,candidateId,body,'revoke');}
    @Post('candidates/:candidateId/activate')activate(@Req()req:Request,@Param('id')id:string,@Param('candidateId')candidateId:string,@Body()body:LearningCandidateActionInput){return this.learning.candidateAction(req,id,candidateId,body,'activate');}
}
