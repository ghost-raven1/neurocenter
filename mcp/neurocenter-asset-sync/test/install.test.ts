import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installBridgeGlobal } from '../src/lib/install.js';

describe('Подключение моста к OpenCode', () => {
    let root: string;
    let config: string;
    beforeEach(async () => {
        root=await mkdtemp(path.join(tmpdir(),'neurocenter-config-'));
        vi.stubEnv('XDG_CONFIG_HOME',root);
        await mkdir(path.join(root,'opencode'));
        config=path.join(root,'opencode','opencode.jsonc');
    });
    afterEach(async () => { vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); });

    it('Сохраняет комментарии, модель и другие MCP-серверы', async () => {
        await writeFile(config,'// Настройки команды\n{"model":"team/model","mcp":{"existing":{"type":"remote","url":"https://example.test/mcp"}}}\n');
        const result=await installBridgeGlobal();
        const text=await readFile(config,'utf8');
        const data=parse(text);

        expect(text).toContain('// Настройки команды');
        expect(data.model).toBe('team/model');
        expect(data.mcp.existing.url).toBe('https://example.test/mcp');
        expect(data.mcp['neurocenter-asset-sync'].command[1]).toBe(result.indexJs);
        expect(result.indexJs).not.toContain('/lib/index.js');
    });

    it('Повторная установка не дублирует запись и не повреждает JSONC', async () => {
        await writeFile(config,'{"mcp":{}, // Комментарий\n}\n');
        await installBridgeGlobal();
        const before=await readFile(config,'utf8');
        await installBridgeGlobal();
        expect(await readFile(config,'utf8')).toBe(before);
        expect(Object.keys(parse(before).mcp)).toEqual(['neurocenter-asset-sync']);
    });

    it('Не изменяет повреждённую конфигурацию', async () => {
        const invalid='{"mcp": {';
        await writeFile(config,invalid);
        await expect(installBridgeGlobal()).rejects.toThrow('не изменён');
        expect(await readFile(config,'utf8')).toBe(invalid);
    });

    it('Создаёт новый конфиг, когда OpenCode ещё не настроен', async () => {
        const result=await installBridgeGlobal();
        expect(result.created).toBe(true);
        expect(parse(await readFile(result.configPath,'utf8')).mcp['neurocenter-asset-sync'].enabled).toBe(true);
    });
});
