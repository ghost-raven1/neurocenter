import { BadRequestException, Body, Controller, ForbiddenException, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { SkillsService } from './skills.service';
import { importedSkillSnapshot, type ISkillImportExpected } from './asset-import';

interface IInternalImport { input?:unknown; actor?:unknown; requestKey?:unknown; expected?:ISkillImportExpected; id?:unknown; restore?:unknown }

/** Публичный gateway не маршрутизирует internal; токен каталога не заменяется параметрами браузера. */
@Controller('internal/asset-sources/skills')
export class SkillAssetImportController {
    constructor(private readonly skills: SkillsService) {}
    private authorize(req: Request): void {
        const expected = Buffer.from(process.env.NEUROCENTER_INTERNAL_TOKEN??''), header = req.headers['x-neurocenter-internal'];
        const supplied = Buffer.from(typeof header==='string'?header:'');
        if (!expected.length || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) { throw new ForbiddenException('Требуется внутренний доступ каталога.'); }
    }
    private actor(value: unknown): string {
        if (typeof value!=='string' || value.length>254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+$/.test(value)) { throw new BadRequestException('Требуется исполнитель импорта.'); }
        return value.toLowerCase();
    }
    private expected(value: unknown): ISkillImportExpected {
        const expected = value as Partial<ISkillImportExpected>|undefined;
        if (!expected || typeof expected.id!=='string' || !/^common\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expected.id)
            || !Number.isSafeInteger(expected.version) || Number(expected.version)<1 || typeof expected.hash!=='string' || !/^[a-f0-9]{64}$/.test(expected.hash)) {
            throw new BadRequestException('Нужен точный снимок скилла из предварительного просмотра.');
        }
        return expected as ISkillImportExpected;
    }
    @Post('preview')
    preview(@Req() req: Request,@Body() body: IInternalImport) { this.authorize(req); return this.skills.previewAssetSkill(body?.input); }
    @Post('inspect')
    inspect(@Req() req: Request,@Body() body: IInternalImport) {
        this.authorize(req);
        if (typeof body?.id!=='string' || !body.id.startsWith('common/')) { throw new BadRequestException('Выберите общий скилл.'); }
        return this.skills.inspectAssetSkill(body.id);
    }
    @Post('publish')
    async publish(@Req() req: Request,@Body() body: IInternalImport) {
        this.authorize(req);
        if (typeof body?.requestKey!=='string') { throw new BadRequestException('Передайте ключ сохранённого импорта.'); }
        const file = await this.skills.importAssetSkill(body.input,body.requestKey,this.actor(body.actor),body.expected===undefined?undefined:this.expected(body.expected));
        return importedSkillSnapshot(file);
    }
    @Post('archive')
    async archive(@Req() req: Request,@Body() body: IInternalImport) {
        this.authorize(req);
        if(body.requestKey!==undefined&&(typeof body.requestKey!=='string'||!/^[a-f0-9-]{36}$/.test(body.requestKey))){throw new BadRequestException('Некорректный ключ архивирования.');}
        if (typeof body?.id!=='string' || body.restore!==undefined && typeof body.restore!=='boolean') { throw new BadRequestException('Выберите скилл и действие архива.'); }
        return importedSkillSnapshot(await this.skills.archiveAssetSkill(body.id,this.expected(body.expected),this.actor(body.actor),body.restore===true,body.requestKey as string|undefined));
    }
    @Get('archived')
    archived(@Req() req: Request) { this.authorize(req); return this.skills.archivedAssetSkills(); }
    @Post('legacy-inspect')
    legacyInspect(@Req() req:Request,@Body() body:{id:string}){this.authorize(req);return this.skills.inspectLegacySkill(body?.id);}
    @Post('legacy-retire')
    legacyRetire(@Req() req:Request,@Body() body:{id:string;expected:import('./legacy-retirement').ILegacySkillExpected;actor:unknown;requestKey:string}){
        this.authorize(req);return this.skills.retireLegacySkill(body?.id,body?.expected,this.actor(body?.actor),body?.requestKey);
    }
}
