import {Body,Controller,Get,Header,HttpCode,Post,Put,Req} from '@nestjs/common';
import type {Request} from 'express';
import {BridgeSourceService} from './bridge-source.service';
import type {IBridgeSourceSave,IBridgeSourceCheck,IBridgeSourceImport} from './bridge-source.dto';

/** Настройки источника не меняют установленный мост: подготовка новой поставки выполняется отдельно. */
@Controller('api/bridge-source')
export class BridgeSourceController {
    constructor(private readonly service:BridgeSourceService){}
    /** Текущий источник, последнее проверенное предложение и реально импортированная поставка. */
    @Get() @Header('Cache-Control','no-store') async get(@Req() req:Request){await this.service.authorize(req);return this.service.view();}
    /** Главный администратор меняет URL с expectedRevision; действующий мост и поставка сохраняются. */
    @Put() async save(@Req() req:Request,@Body() body:IBridgeSourceSave){return this.service.save(await this.service.authorize(req,true),body);}
    /** Online читает metadata за 45 секунд; offline проверяет локальную поставку без изменения upstream checkedAt. */
    @Post('check') @HttpCode(200) @Header('Cache-Control','no-store') async check(@Req() req:Request,@Body() body:IBridgeSourceCheck){await this.service.authorize(req);return this.service.check(body);}
    /** Явно готовит проверенный commit через обычную очередь импорта; requestKey обеспечивает безопасный повтор. */
    @Post('import') async import(@Req() req:Request,@Body() body:IBridgeSourceImport){return this.service.import(await this.service.authorize(req,true),body);}
}
