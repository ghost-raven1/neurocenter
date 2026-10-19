import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import {hub} from '../bridge/state.js';

/** Регистрирует мост в JSON/JSONC-конфиге OpenCode, сохраняя комментарии и другие настройки. */
export async function installBridgeGlobal(): Promise<{
    configPath: string; indexJs: string; node: string; created: boolean; method: 'json' | 'jsonc';
}> {
    const indexJs = fileURLToPath(new URL('../index.js', import.meta.url));
    const nodePath = process.execPath;
    const entry = { type: 'local', enabled: true, command: [nodePath, indexJs],environment:{NEUROCENTER_URL:hub()} };
    const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
    let target: string | null = null;
    for (const name of ['opencode.jsonc', 'opencode.json']) {
        const candidate = path.join(dir, name);
        try { await fs.access(candidate); target = candidate; break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    const configPath = target ?? path.join(dir, 'opencode.json');
    const text = target ? await fs.readFile(target, 'utf8') : '{}\n';
    const errors: ParseError[] = [];
    const parsed: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Конфигурация OpenCode повреждена. Исправьте JSON/JSONC и повторите установку; файл не изменён.');
    }
    const mcp = (parsed as { mcp?: unknown }).mcp;
    if (mcp !== undefined && (mcp === null || typeof mcp !== 'object' || Array.isArray(mcp))) {
        throw new Error('Поле mcp должно быть объектом. Конфигурация не изменена.');
    }
    const out = applyEdits(text, modify(text, ['mcp', 'neurocenter-asset-sync'], entry, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
    }));
    await fs.mkdir(dir, { recursive: true });
    // Пишем рядом с реальным файлом: сохраняем симлинки и атомарно заменяем содержимое.
    const destination = target ? await fs.realpath(target) : configPath;
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
        const mode = target ? (await fs.stat(target)).mode & 0o777 : 0o600;
        await fs.writeFile(temporary, out, { mode });
        await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
    return { configPath, indexJs, node: nodePath, created: !target, method: target?.endsWith('.jsonc') ? 'jsonc' : 'json' };
}
