import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('Граница установки через локальный MCP', () => {
    it('Не публикует старые инструменты и не выполняет их прямую запись без подключения', async () => {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-boundary-'));
        const client = new Client({ name: 'проверка-границ', version: '1.0.0' });
        const target = path.join(temporary, 'проект');
        const file = path.join(target, '.opencode/skills/helper/SKILL.md');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, 'Ручная инструкция');
        try {
            await client.connect(new StdioClientTransport({
                command: process.execPath,
                args: ['--import', 'tsx', path.resolve('src/index.ts')],
                cwd: process.cwd(),
                stderr: 'ignore',
                env: {
                    ...process.env,
                    HOME: temporary,
                    XDG_CONFIG_HOME: path.join(temporary, 'config'),
                    NEUROCENTER_URL: 'http://127.0.0.1:1',
                    NEUROCENTER_BRIDGE_HOME: path.join(temporary, 'private'),
                },
            }));
            const listed = (await client.listTools()).tools.map(tool => tool.name);
            expect(listed).not.toContain('install_asset');
            expect(listed).not.toContain('install_plugin_bundle');
            for (const input of [
                { name: 'install_asset', arguments: { kind: 'skill', name: 'helper', targetPath: target, content: 'Перезапись' } },
                { name: 'install_asset', arguments: { kind: 'skill', name: 'helper', targetPath: target, action: 'uninstall' } },
                { name: 'install_asset', arguments: { kind: 'plugin', name: '../../../outside', targetPath: target, content: 'Перезапись' } },
                { name: 'install_plugin_bundle', arguments: { plugin: 'helper', targetPath: target } },
            ]) {
                expect((await client.callTool(input)).isError).toBe(true);
            }
            expect(await fs.readFile(file, 'utf8')).toBe('Ручная инструкция');
            await expect(fs.access(path.join(temporary, 'outside.js'))).rejects.toThrow();
        } finally {
            await client.close();
            await fs.rm(temporary, { recursive: true, force: true });
        }
    }, 15000);
});
