import {BadRequestException,Body,Controller,Get,Patch} from '@nestjs/common';
import {ProjectDatabases} from '../project-databases';
import {validatePlatformQuotaUpdate,type IPlatformQuotaUpdate} from './platform-quota';

/** Internal token middleware admits only the main-admin coordinator from Catalog. */
@Controller('internal/platform-rag-quota')
export class PlatformQuotaController {
    constructor(private readonly databases:ProjectDatabases){}
    @Get() get(){return this.databases.platformQuota();}
    @Patch() save(@Body() body:{policy:IPlatformQuotaUpdate;actor:string}){
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='actor,policy')throw new BadRequestException('Укажите настройки и автора.');
        validatePlatformQuotaUpdate(body.policy);
        return this.databases.platformQuota(body.policy,body.actor);
    }
}
