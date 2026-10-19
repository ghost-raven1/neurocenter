import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

export const scanPluginsInputSchema = z
    .object({
        configPath: z
            .string()
            .optional()
            .describe('Путь к opencode.json/opencode.jsonc (деф. — автопоиск в CWD/.opencode и ~/.config/opencode).'),
    })
    .strict();

export type TScanPluginsInput = z.infer<typeof scanPluginsInputSchema>;

export interface IMcpServerEntry {
    name: string;
    type: string;
    enabled: boolean;
    command: string[];
}

export interface IPluginDirEntry {
    dir: string;
    entries: string[];
}

export interface IPluginScan {
    mcpConfigPath: string | null;
    mcpServers: IMcpServerEntry[];
    pluginDirs: IPluginDirEntry[];
    total: number;
}

interface IRawMcp {
    type?: unknown;
    enabled?: unknown;
    command?: unknown;
}

interface IOpencodeJson {
    mcp?: Record<string, IRawMcp>;
}

async function readJson(p: string): Promise<IOpencodeJson | null> {
    try {
    // .jsonc: грубо уберем комментарии (best-effort, не для всех случаев).
        const raw = await fs.readFile(p, 'utf8');
        return JSON.parse(raw) as IOpencodeJson;
    } catch {
        return null;
    }
}

/**
 * Собирает список MCP-серверов из `opencode.json` (поле `mcp`) и содержимое
 * каталогов плагинов (project `.opencode/plugins`, global `~/.config/opencode/plugins`).
 *
 * @param configPathHint - явный путь к конфигy (опционально).
 * @param cwd - базовый каталог.
 */
export async function scanPlugins(
    configPathHint: string | undefined,
    cwd: string,
): Promise<IPluginScan> {
    const candidates = [
        configPathHint ? path.resolve(cwd, configPathHint) : undefined,
        path.join(cwd, '.opencode', 'opencode.json'),
        path.join(cwd, 'opencode.json'),
        path.join(cwd, '.opencode', 'opencode.jsonc'),
        path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'),
        path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);

    let cfgPath: string | null = null;
    let cfg: IOpencodeJson | null = null;
    for (const c of candidates) {
        const r = await readJson(c);
        if (r) {
            cfgPath = c;
            cfg = r;
            break;
        }
    }

    const mcpServers: IMcpServerEntry[] = [];
    if (cfg?.mcp) {
        for (const [ name, v ] of Object.entries(cfg.mcp)) {
            mcpServers.push({
                name,
                type: typeof v.type === 'string' ? v.type : 'unknown',
                enabled: v.enabled === true,
                command: Array.isArray(v.command)
                    ? v.command.filter((x): x is string => typeof x === 'string')
                    : [],
            });
        }
    }

    const pluginDirs: IPluginDirEntry[] = [];
    const dirCandidates = [
        path.join(cwd, '.opencode', 'plugins'),
        path.join(os.homedir(), '.config', 'opencode', 'plugins'),
    ];
    for (const d of dirCandidates) {
        try {
            const names = await fs.readdir(d);
            pluginDirs.push({ dir: d, entries: names });
        } catch {
            // каталог отсутствует — пропускаем.
        }
    }

    const total =
    mcpServers.length + pluginDirs.reduce((n, p) => n + p.entries.length, 0);
    return { mcpConfigPath: cfgPath, mcpServers, pluginDirs, total };
}
