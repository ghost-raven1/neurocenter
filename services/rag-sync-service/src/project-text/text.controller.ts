import {BadRequestException,Body,Controller,Post} from '@nestjs/common';
import {ProjectDatabases} from '../rag/project-databases';
import {textProject,type TextActor} from './text-values';

/** The existing /internal middleware requires the shared token before these handlers run. */
@Controller('internal/project-rag/text')
export class ProjectTextController {
    constructor(private readonly databases:ProjectDatabases){}

    private project(body:unknown):string{
        if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('Нужен текстовый запрос проекта.');
        return textProject((body as {projectId?:unknown}).projectId);
    }
    @Post('state') state(@Body() body:{projectId:string}){
        return this.databases.withProject(this.project(body),(db,id)=>db.text.state(id));
    }
    @Post('receipt') receipt(@Body() body:{projectId:string;requestKey:string;actor:TextActor}){
        return this.databases.withProject(this.project(body),(db,id)=>db.text.receipt(id,body.requestKey,body.actor));
    }
    @Post('upload') upload(@Body() body:{projectId:string;input:unknown;requestHash:string;actor:TextActor}){
        return this.databases.withProject(this.project(body),(db,id)=>db.text.upload(id,body.input,body.requestHash,body.actor));
    }
    @Post('search') search(@Body() body:{projectId:string;input:unknown}){
        return this.databases.withProject(this.project(body),(db,id)=>db.text.search(id,body.input));
    }
}
