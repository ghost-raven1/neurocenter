import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertInternal } from '../access/access.controller';
import { ProjectTextKnowledge } from './project-text.service';
import type { TextUpload, TextSearch } from '../../../shared/project-text-knowledge.cjs';

/** Browser project authority is independent from the optional semantic embedding service. */
@Controller('api/projects/:id/knowledge/text')
export class ProjectTextController {
    constructor(private readonly text: ProjectTextKnowledge) {}
    @Get() state(@Req() req: Request, @Param('id') id: string) {
        return this.text.state(req, id);
    }
    @Post('documents') upload(@Req() req: Request, @Param('id') id: string, @Body() input: TextUpload) {
        return this.text.upload(req, id, input);
    }
    @Get('requests/:key') async receipt(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('key') key: string,
        @Res() res: Response,
    ) {
        res.json(await this.text.receipt(req, id, key));
    }
    @Post('search') search(@Req() req: Request, @Param('id') id: string, @Body() input: TextSearch) {
        return this.text.search(req, id, input);
    }
}
@Controller('internal/project-text')
export class ProjectTextAuthorizationController {
    constructor(private readonly text: ProjectTextKnowledge) {}
    @Post('authorize') authorize(@Req() req: Request, @Body() input: unknown) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.text.authorize(input);
    }
}
