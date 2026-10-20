import { BadRequestException, BadGatewayException, ConflictException } from '@nestjs/common';
import { renderSkillInstruction } from '../../../shared/skill-package.cjs';
import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';
import { buildPackage } from '../catalog/bundle-package';

/** Один builder для назначения проекта и доставки exact native skill version. */
export async function readSkillPackage(id:string,version:number) {
    const kind='skill';
    const url =
            (process.env.SKILLS_SERVICE_URL || 'http://localhost:4200') +
            '/api/skills/_package/' +
            id.split('/').map(encodeURIComponent).join('/') + '?version=' + version;
        const response = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
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
                name?: string;
                tags?: string[];
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
        const pkg=buildPackage(
            { id, name: data.meta.slug, kind, version },
            [{ path: 'SKILL.md', content }, ...(data.resources || [])],
            new Date().toISOString(),
            { extra: { requirements, ...(data.meta.generation ? { generation: data.meta.generation } : {}) } },
        );
        return {...data,resources:data.resources??[],package:pkg};
}

export async function buildSkillPackage(id:string,version:number){return (await readSkillPackage(id,version)).package;}
