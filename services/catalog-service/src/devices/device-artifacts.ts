import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { buildSkillPackage } from '../publication/skill-package';

/** Доставка использует native immutable version, не случайный новый head. */
@Injectable()
export class DeviceArtifacts {
    constructor(private readonly catalog: CatalogService) {}
    async build(kind: string, id: string, version: number) {
        if (!['skill', 'mcp', 'plugin'].includes(kind) || !id || !Number.isSafeInteger(version) || version < 1) {
            throw new BadRequestException('Нужны инструмент и точная версия.');
        }
        if (kind === 'skill') return buildSkillPackage(id, version);
        const pkg = await this.catalog.getAiPluginPackage(id, version);
        if (pkg.plugin.kind !== kind) throw new BadRequestException('Тип инструмента изменился.');
        return pkg;
    }
}
