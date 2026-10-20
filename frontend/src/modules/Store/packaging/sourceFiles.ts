import type { PackagingFile } from './types';

export interface PackagingInputFile { name: string; size: number; webkitRelativePath?: string; arrayBuffer: () => Promise<ArrayBuffer> }
export interface PackagingFilesResult { files: PackagingFile[]; skipped: number; rootName?: string }
const ignored = (parts: string[]): boolean => parts.some(raw => {
    const part = raw.toLowerCase();
    return ['.git', 'node_modules', 'dist', 'build', '.npmrc', '.yarnrc', '.yarnrc.yml', '__macosx', '.ds_store'].includes(part)
        || part.startsWith('._') || /^\.env(?:\.|$)/.test(part) || /^(?:id_rsa|id_ed25519)(?:\.|$)/.test(part) || /\.(?:pem|key)$/.test(part);
});

/** Выбранная папка превращается в переносимые UTF-8 исходники, без зависимостей и секретных файлов. */
export async function readPackagingFiles(input: readonly PackagingInputFile[]): Promise<PackagingFilesResult> {
    const selected = input.map(file => ({ file, relative: file.webkitRelativePath || file.name }));
    const rootName = selected.length && selected.every(({ file, relative }) => !!file.webkitRelativePath && relative.split('/')[0] === selected[0].relative.split('/')[0])
        ? selected[0].relative.split('/')[0] : undefined;
    const files: PackagingFile[] = [];
    const seen = new Set<string>();
    let skipped = 0, bytes = 0;
    for (const { file, relative } of selected) {
        if (!relative || relative.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(relative)
            || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('В исходниках найден непереносимый путь.');
        const parts = relative.split('/').slice(rootName ? 1 : 0);
        if (ignored(parts)) { skipped++; continue; }
        const name = parts.join('/');
        if (!name || new TextEncoder().encode(name).length > 240 || /[<>"|?*]/.test(name) || parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part))) throw new Error('В исходниках найден непереносимый путь.');
        const key = name.normalize('NFC').toLowerCase();
        if (seen.has(key)) throw new Error('В исходниках повторяется путь: ' + name);
        if (files.length >= 100 || file.size > 1024 * 1024 || bytes + file.size > 5 * 1024 * 1024) throw new Error('Добавьте до 100 текстовых файлов: до 1 МБ каждый и до 5 МБ всего.');
        let content: string;
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
        catch { throw new Error('Нужны текстовые исходники UTF-8: ' + name); }
        if (content.includes('\0')) throw new Error('Нужны текстовые исходники UTF-8: ' + name);
        seen.add(key); bytes += file.size; files.push({ path: name, content });
    }
    if (!files.length) throw new Error('В папке нет подходящих текстовых исходников.');
    return { files, skipped, rootName };
}

/** Предпочитает bin/main из package.json и предлагает только существующие JS/TS файлы. */
export function packagingEntrypoints(files: PackagingFile[], kind: 'mcp' | 'plugin'): string[] {
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
