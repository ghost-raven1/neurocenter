/** Скилл внутри пространства проекта уже входит в его каталог и не требует копирования из общего. */
export function isProjectSkill(kind: unknown, id: unknown, projectId: unknown): boolean {
    if (kind !== 'skill' || typeof id !== 'string' || typeof projectId !== 'string' || !projectId) { return false; }
    const [scope, ...parts] = id.split('/');
    return scope === `project-${projectId}` && parts.length > 0 && parts.every(part => /^[a-z0-9][a-z0-9_-]*$/.test(part));
}
import {BadRequestException,ForbiddenException} from '@nestjs/common';


/** Запись в project_assets не даёт права читать инструкции чужого проекта через внутренний сервис. */
export function assertProjectCatalogAsset(kind: unknown, id: unknown, projectId: unknown): void {
    if (typeof kind !== 'string' || !['skill','mcp','plugin'].includes(kind) || typeof id !== 'string' || !id || id.length > (kind === 'skill' ? 240 : 512)) {
        throw new BadRequestException('Выберите инструмент из каталога.');
    }
    if (kind !== 'skill') { return; }
    const parts = id.split('/');
    if (parts.some(part => !/^[a-z0-9][a-z0-9_-]*$/.test(part))) { throw new BadRequestException('Недопустимый путь скилла.'); }
    if ((parts[0] === 'project' || parts[0].startsWith('project-')) && !isProjectSkill(kind,id,projectId)) {
        throw new ForbiddenException('Скилл другого проекта нельзя подключить ссылкой. Используйте общий каталог или отдельную копию в целевом проекте.');
    }
}
