import {Body,Controller,Post,Req} from '@nestjs/common';
import type {Request} from 'express';
import {AssetSourcesService} from './asset-sources.service';
import {LegacyRetirementService} from './legacy-retirement.service';

/** Main-admin-only preview/apply; the audited policy supplies every path and project identity. */
@Controller('api/asset-management/legacy-retirement')
export class LegacyRetirementController {
    constructor(private readonly source:AssetSourcesService,private readonly retirement:LegacyRetirementService){}
    @Post('preview') async preview(@Req() req:Request,@Body() body:unknown){return this.retirement.preview(await this.source.actor(req),body);}
    @Post('apply') async apply(@Req() req:Request,@Body() body:unknown){return this.retirement.apply(await this.source.actor(req),body);}
}
