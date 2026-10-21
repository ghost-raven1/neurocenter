import {BadRequestException,Body,Controller,Get,Post} from '@nestjs/common';
import {DatabaseLifecycle} from './database-lifecycle';
import type {IPurgeCommand} from './lifecycle-types';

/** Только catalog coordinator с internal token; публичный mainadmin guard остаётся в каталоге. */
@Controller('internal/retired-rag')
export class DatabaseLifecycleController {
    constructor(private readonly lifecycle:DatabaseLifecycle){}
    @Get('inventory') inventory(){return this.lifecycle.inventory();}
    @Post('preview') preview(@Body() body:{projectId:string;retirementId:string}){
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='projectId,retirementId')throw new BadRequestException('Укажите точные ID проекта и сохранённой базы.');
        return this.lifecycle.preview(body.projectId,body.retirementId);
    }
    @Post('purge') purge(@Body() body:IPurgeCommand){return this.lifecycle.execute(body);}
}
