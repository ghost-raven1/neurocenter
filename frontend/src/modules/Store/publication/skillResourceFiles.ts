import type { ISkillResource } from '../../../core/api/interfaces';

/** Один набор проверяется целиком: ошибка импорта не добавляет половину выбранных файлов. */
export function checkSkillResources(resources: ISkillResource[]): void {
    if (resources.length > 99) { throw new Error('Допускается до 99 ресурсов.'); }
    const paths = new Set<string>(); let total = 0;
    for (const file of resources) {
        if (!/^(scripts|references|assets)\//.test(file.path) || file.path.length > 200 || file.path.includes('\\')
            || file.path.split('/').some(part => !part || part === '.' || part === '..' || new TextEncoder().encode(part).length > 240 || /[<>:"|?*\x00-\x1f\x7f]/.test(part)
                || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) {
            throw new Error('Укажите переносимый путь в scripts/, references/ или assets/.');
        }
        const key = file.path.normalize('NFC').toLowerCase();
        if (paths.has(key) || [...paths].some(other => other.startsWith(key + '/') || key.startsWith(other + '/'))) { throw new Error('Пути ресурсов конфликтуют. Переименуйте файл или удалите повтор.'); }
        paths.add(key);
        const size = file.encoding === 'base64' ? atob(file.content).length : new TextEncoder().encode(file.content).length;
        total += size;
        if (size > 1024 * 1024 || total > 4 * 1024 * 1024) { throw new Error('Лимит: 1 МиБ на ресурс и 4 МиБ на все ресурсы.'); }
    }
}

/** Папка скилла может содержать scripts, references и assets; SKILL.md редактируется отдельно. */
export async function readSkillResources(files: File[]): Promise<ISkillResource[]> {
    if (files.length > 100) { throw new Error('Допускается до 99 ресурсов и отдельный SKILL.md.'); }
    let total = 0;
    const resources: ISkillResource[] = [];
    for (const file of files) {
        let relative = file.webkitRelativePath || `assets/${file.name}`;
        if (file.webkitRelativePath && !/^(scripts|references|assets)\//.test(relative)) { relative = relative.split('/').slice(1).join('/'); }
        if (relative === 'SKILL.md') { continue; }
        total += file.size;
        if (file.size > 1024 * 1024 || total > 4 * 1024 * 1024) { throw new Error('Лимит: 1 МиБ на ресурс и 4 МиБ на набор.'); }
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); }
        resources.push({path:relative.normalize('NFC'),content:btoa(binary),encoding:'base64'});
    }
    checkSkillResources(resources);
    return resources;
}
