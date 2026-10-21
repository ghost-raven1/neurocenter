import type { PackagingFile, PackagingKind } from './types';
import {skillSourceEntrypoints} from '../../../../../services/shared/skill-source.mjs';

export interface PackagingInputFile { name: string; size: number; webkitRelativePath?: string; arrayBuffer: () => Promise<ArrayBuffer> }
export interface PackagingFilesResult { files: PackagingFile[]; skipped: number; rootName?: string }
const ignored = (parts: string[],skill:boolean): boolean => parts.some(raw => {
    const part = raw.toLowerCase();
    return ['.git', 'node_modules', '.npmrc', '.yarnrc', '.yarnrc.yml', '__macosx', '.ds_store',...(skill?[]:['dist','build'])].includes(part)
        || part.startsWith('._') || /^\.env(?:\.|$)/.test(part) || /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key)$/.test(part);
});

/** Исходники остаются UTF-8; бинарные ресурсы скиллов сохраняют точные байты через штатный base64. */
export async function readPackagingFiles(input: readonly PackagingInputFile[]): Promise<PackagingFilesResult> {
    const selected = input.map(file => ({ file, relative: file.webkitRelativePath || file.name }));
    const rootName = selected.length && selected.every(({ file, relative }) => !!file.webkitRelativePath && relative.split('/')[0] === selected[0].relative.split('/')[0])
        ? selected[0].relative.split('/')[0] : undefined;
    const instructionRoots=selected.map(({relative})=>relative.split('/').slice(rootName?1:0).join('/')).filter(relative=>/(?:^|\/)SKILL\.md$/.test(relative)).map(relative=>relative.slice(0,-'SKILL.md'.length));
    const skill=instructionRoots.length>0;
    const files: PackagingFile[] = [];
    const seen = new Set<string>();
    let skipped = 0, bytes = 0;
    for (const { file, relative } of selected) {
        if (!relative || relative.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(relative)
            || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('В исходниках найден непереносимый путь.');
        const parts = relative.split('/').slice(rootName ? 1 : 0);
        if (ignored(parts,skill)) { skipped++; continue; }
        const name = parts.join('/');
        if (!name || new TextEncoder().encode(name).length > 240 || /[<>"|?*]/.test(name) || parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) throw new Error('В исходниках найден непереносимый путь.');
        const key = name.normalize('NFC').toLowerCase();
        if (seen.has(key)) throw new Error('В исходниках повторяется путь: ' + name);
        if (files.length >= 100 || file.size > 1024 * 1024 || bytes + file.size > 5 * 1024 * 1024) throw new Error('Добавьте до 100 текстовых файлов: до 1 МБ каждый и до 5 МБ всего.');
        const buffer=new Uint8Array(await file.arrayBuffer());
        let content:string,encoding:'base64'|undefined;
        try {content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(buffer);if(content.includes('\0'))throw new Error('binary');}
        catch {
            if(!instructionRoots.some(root=>name.startsWith(root)&&/^(scripts|references|assets)\//.test(name.slice(root.length))))throw new Error('Нужны текстовые исходники UTF-8: '+name);
            const chunks:string[]=[];for(let index=0;index<buffer.length;index+=8192)chunks.push(String.fromCharCode(...buffer.subarray(index,index+8192)));
            content=btoa(chunks.join(''));encoding='base64';
        }
        seen.add(key); bytes += file.size; files.push({ path: name, content,...(encoding?{encoding}:{}) });
    }
    if (!files.length) throw new Error('В папке нет подходящих текстовых исходников.');
    return { files, skipped, rootName };
}

/** Предпочитает bin/main из package.json и предлагает только существующие JS/TS файлы. */
export function packagingEntrypoints(files: PackagingFile[], kind: PackagingKind): string[] {
    if (kind === 'skill') return skillSourceEntrypoints(files);
    const existing = new Set(files.map(file => file.path));
    const candidates: string[] = [];
    try {
        const metadata = JSON.parse(files.find(file => file.path === 'package.json')?.content ?? '{}') as { bin?: string | Record<string, string>; main?: string; module?: string };
        const bins = (typeof metadata.bin === 'string' ? [metadata.bin] : Object.values(metadata.bin ?? {})).filter((value): value is string => typeof value === 'string');
        candidates.push(...(kind === 'mcp' ? bins : [metadata.module, metadata.main].filter((value): value is string => typeof value === 'string')));
    } catch { /* Сервер сообщит об ошибке package.json при сборке; список файлов остаётся доступным. */ }
    if (!candidates.some(value => existing.has(value.replace(/^\.\//, '')))) {
        candidates.push('index.ts', 'index.js', 'src/index.ts', 'src/index.js', ...files.map(file => file.path));
    }
    return [...new Set(candidates.map(value => value.replace(/^\.\//, '')))].filter(value => existing.has(value)
        && /\.(?:[cm]?[jt]s|tsx)$/.test(value) && !/\.d\.[cm]?ts$/.test(value));
}
