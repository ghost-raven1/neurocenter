import type { ISkillResource } from '../../core/api/interfaces';

export interface IInstructionResourceLink { path: string; fragment: string; }

/** Принимает только переносимый путь внутри опубликованных ресурсов текущего скилла. */
export function safeInstructionResourcePath(value: string): boolean {
    return /^(scripts|references|assets)\//.test(value) && value.length <= 240
        && !/[\\<>:"|?*\u0000-\u001f\u007f]/.test(value)
        && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
            && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part));
}

/** Ссылка никогда не становится сетевым URL: ../ разрешён только до корня этого пакета. */
export function instructionResourceLink(value: string, resources: ISkillResource[], from = 'SKILL.md'): IInstructionResourceLink | undefined {
    if (!value || /[\u0000-\u0020\\]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) { return undefined; }
    const separator = value.indexOf('#');
    let relative: string, fragment: string;
    try {
        relative = decodeURIComponent(separator < 0 ? value : value.slice(0, separator));
        fragment = decodeURIComponent(separator < 0 ? '' : value.slice(separator + 1));
    } catch { return undefined; }
    if (/[\\\u0000-\u001f\u007f]/.test(relative + fragment) || relative.startsWith('/') || relative.includes('?')) { return undefined; }
    if (from !== 'SKILL.md' && !safeInstructionResourcePath(from)) { return undefined; }
    const parts = relative ? from.split('/').slice(0, -1) : from.split('/');
    for (const part of relative ? relative.split('/') : []) {
        if (part === '.') { continue; }
        if (part === '..') { if (!parts.length) { return undefined; } parts.pop(); }
        else if (part) { parts.push(part); }
        else { return undefined; }
    }
    const path = parts.join('/').normalize('NFC');
    if (path !== 'SKILL.md' && (!safeInstructionResourcePath(path) || !resources.some(resource => resource.path === path))) { return undefined; }
    return { path, fragment };
}

/** Бинарные байты не интерпретируются как HTML или URL, повреждённый base64 не ломает карточку. */
export function instructionResourceText(resource: ISkillResource): string | undefined {
    try {
        const binary = resource.encoding === 'base64' ? atob(resource.content) : undefined;
        if (binary !== undefined && btoa(binary) !== resource.content) { return undefined; }
        const value = binary === undefined ? resource.content : new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
        return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) ? undefined : value;
    } catch { return undefined; }
}
