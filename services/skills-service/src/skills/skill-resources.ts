import { BadRequestException } from '@nestjs/common';
import type { ISkillResource } from './skills.model';

/** Проверяет весь набор до записи: переносимые пути, однозначное кодирование и бюджет байтов. */
export function validateResources(value: unknown): ISkillResource[] {
    if (value === undefined) { return []; }
    if (!Array.isArray(value) || value.length > 99) {
        throw new BadRequestException('Допускается до 99 ресурсов скилла.');
    }
    const paths = new Set<string>();
    let total = 0;
    const resources = value.map((item: ISkillResource) => {
        if (!item || typeof item !== 'object' || typeof item.path !== 'string'
            || item.path.length > 200 || !/^(scripts|references|assets)\//.test(item.path)
            || item.path.includes('\\') || item.path.split('/').some(part => !part || part === '.' || part === '..'
                || Buffer.byteLength(part, 'utf8') > 240 || /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part)
                || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
            throw new BadRequestException('Ресурс должен находиться в scripts/, references/ или assets/ и иметь переносимый относительный путь.');
        }
        const key = item.path.normalize('NFC').toLowerCase();
        if (paths.has(key) || [...paths].some(other => other.startsWith(key + '/') || key.startsWith(other + '/'))) {
            throw new BadRequestException('Пути ресурсов конфликтуют между собой.');
        }
        paths.add(key);
        if (typeof item.content !== 'string' || ![undefined, 'utf8', 'base64'].includes(item.encoding)) {
            throw new BadRequestException('Ресурс должен содержать строку UTF-8 или base64.');
        }
        const bytes = Buffer.from(item.content, item.encoding === 'base64' ? 'base64' : 'utf8');
        if (item.encoding === 'base64' && bytes.toString('base64') !== item.content) {
            throw new BadRequestException('Некорректное base64-кодирование ресурса.');
        }
        total += bytes.length;
        if (bytes.length > 1024 * 1024 || total > 4 * 1024 * 1024) {
            throw new BadRequestException('Ресурс превышает 1 МиБ или общий объём ресурсов больше 4 МиБ.');
        }
        return { path: item.path.normalize('NFC'), content: item.content, ...(item.encoding === 'base64' ? { encoding: 'base64' as const } : {}) };
    });
    return resources.sort((a, b) => a.path.localeCompare(b.path));
}
