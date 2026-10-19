import {
    BadRequestException,
    BadGatewayException,
    ConflictException,
    Injectable,
} from '@nestjs/common';
import { renderSkillInstruction } from '../../../shared/skill-package.cjs';
import { CatalogService } from '../catalog/catalog.service';
import { buildPackage } from '../catalog/bundle-package';
import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';

/** Фиксирует проверенную версию пакета в задании; worker не скачивает случайный новый head. */
@Injectable()
export class DeviceArtifacts {
    constructor(private readonly catalog: CatalogService) {}
    async build(kind: string, id: string, version: number) {
        if (
            !['skill', 'mcp', 'plugin'].includes(kind) ||
            !id ||
            !Number.isSafeInteger(version) ||
            version < 1
        ) {
            throw new BadRequestException('Нужны инструмент и точная версия.');
        }
        if (kind !== 'skill') {
            const pkg = await this.catalog.getAiPluginPackage(id, version);
            if (pkg.plugin.kind !== kind) {
                throw new BadRequestException('Тип инструмента изменился.');
            }
            return pkg;
        }
        const url =
            (process.env.SKILLS_SERVICE_URL || 'http://localhost:4200') +
            '/api/skills/_package/' +
            id.split('/').map(encodeURIComponent).join('/') + '?version=' + version;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: {
                'x-neurocenter-internal':
                    process.env.NEUROCENTER_INTERNAL_TOKEN || '',
            },
        }).catch(() => {
            throw new BadGatewayException('Сервис скиллов недоступен. Повторите установку после восстановления связи.');
        });
        if (!response.ok) {
            throw new BadGatewayException(
                'Не удалось прочитать скилл. Обновите карточку и повторите установку.',
            );
        }
        const data = (await response.json().catch(() => {
            throw new BadGatewayException('Сервис скиллов вернул повреждённые данные. Установка не начата.');
        })) as {
            meta: {
                slug: string;
                description?: string;
                version: number;
                mcp?: string[];
                plugins?: string[];
                generation?: string;
                dependencies?: IDependencyPin[];
            };
            body: string;
            resources?: Array<{ path: string; content: string; encoding?: 'utf8' | 'base64' }>;
        };
        if (!data || !data.meta || typeof data.body !== 'string' || !Array.isArray(data.resources ?? [])) {
            throw new BadGatewayException('Сервис скиллов вернул неполную версию. Установка не начата.');
        }
        if (data.meta.version !== version) {
            throw new ConflictException(
                'Скилл изменился. Обновите карточку перед установкой.',
            );
        }
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.meta.slug)) {
            throw new BadRequestException(
                'Скиллу нужен технический идентификатор латиницей.',
            );
        }
        let dependencies: IDependencyPin[];
        try { dependencies = normalizeDependencyPins(data.meta.dependencies); }
        catch { throw new BadGatewayException('Версия скилла содержит повреждённые зависимости. Установка не начата.'); }
        const requirements = {
            mcp: data.meta.mcp || [],
            plugins: data.meta.plugins || [],
            ...(dependencies.length ? { dependencies } : {}),
        };
        const content = renderSkillInstruction(data.meta, data.body);
        return buildPackage(
            { id, name: data.meta.slug, kind, version },
            [{ path: 'SKILL.md', content }, ...(data.resources || [])],
            new Date().toISOString(),
            { extra: { requirements, ...(data.meta.generation ? { generation: data.meta.generation } : {}) } },
        );
    }
}
