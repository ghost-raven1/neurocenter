import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { bridgeInstallerCommand, installedBridgeCommand } from '../src/features/McpBridge/connectionCommands';

describe('Подключение установленного моста без повторной установки', () => {
    it.each([false, true])('Формирует команду для текущей площадки и reconnect=%s', reconnect => {
        const command = installedBridgeCommand('https://panel.example.test:8443/projects?tab=local', false, reconnect);
        expect(command).toContain('neurocenter-bridge');
        expect(command).toContain('connect --open');
        expect(command).not.toMatch(/NEUROCENTER_URL|INSTALL_DIR|bin\/node|dist\/index/);
        expect(command.includes('--reconnect')).toBe(reconnect);
        expect(command).not.toMatch(/curl|wget|install\.(?:sh|ps1)|--init|npm\s|npx\s/);
        expect(command).not.toContain('projects?tab=local');
    });

    it('Windows использует установленный автономный Node и браузерное подтверждение', () => {
        const command = installedBridgeCommand('http://127.0.0.1:5173', true, true);
        expect(command).not.toContain('NEUROCENTER_URL');
        expect(command).toContain('$env:USERPROFILE');
        expect(command).toContain('neurocenter-bridge.cmd');
        expect(command).toContain('connect --open --reconnect');
        expect(command).not.toContain('dist/index.js');
        expect(command).not.toMatch(/Invoke-WebRequest|\birm\b|\biex\b|--init|install\.ps1/);
    });

    it.each(['file:///tmp/bridge', 'javascript:alert(1)', 'ftp://example.test', 'not a URL'])('Отклоняет неподдерживаемый адрес %s', origin => {
        expect(() => installedBridgeCommand(origin, false)).toThrow();
    });

    it.skipIf(process.platform === 'win32')('Выполняет существующий мост из каталога с пробелами и кавычками, не раскрывая параметры адреса', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-existing-bridge-'));
        try {
            const install = path.join(temporary, "мост с 'кавычкой' и пробелами");
            await mkdir(path.join(install,'.local/bin'),{recursive:true});
            await writeFile(path.join(install,'.local/bin/neurocenter-bridge'),'#!/bin/sh\nprintf \'%s\\n\' "$@"\n',{mode:0o755});
            for (const [address, reconnect] of [
                ['https://owner:secret@panel.example.test:8443/path?x=$(false)#fragment', false],
                ['https://owner:secret@panel.example.test:8443/path?x=$(false)#fragment', true],
                ["https://panel'$(false)'.example.test", false],
            ] as const) {
                const command = installedBridgeCommand(address, false, reconnect);
                const result = spawnSync('/bin/bash', ['-c', command], {
                    env: { ...process.env, HOME: install, PATH: '/usr/bin:/bin' },
                    encoding: 'utf8', timeout: 5000,
                });
                expect(result.status, result.stderr).toBe(0);
                expect(result.stdout.trim().split('\n')).toEqual([
                    'connect','--open',...(reconnect?['--reconnect']:[]),
                ]);
                expect(command).not.toContain('secret');
                if (address.includes('@')) { expect(command).not.toContain('$(false)'); }
            }
        } finally { await rm(temporary, { recursive: true, force: true }); }
    });
});

describe('Установка моста для выбранной системы и площадки', () => {
    it.each([false, true])('Bash использует текущую площадку и reconnect=%s', reconnect => {
        const command = bridgeInstallerCommand('https://panel.example.test:8443/path?other=1', false, reconnect);
        expect(command).toContain(`https://panel.example.test:8443/api/bridge/install.sh${reconnect ? '?reconnect=1' : ''}`);
        expect(command).toMatch(/curl.*\|\s*bash/);
        expect(command).not.toContain('/path');
        if (!reconnect) { expect(command).not.toContain('reconnect=1'); }
    });

    it.each([false, true])('PowerShell использует текущую площадку и reconnect=%s', reconnect => {
        const command = bridgeInstallerCommand("https://panel'.example.test/ignored", true, reconnect);
        expect(command).toContain(`https://panel''.example.test/api/bridge/install.ps1${reconnect ? '?reconnect=1' : ''}`);
        expect(command).toMatch(/(?:irm|Invoke-RestMethod).*\|\s*(?:iex|Invoke-Expression)/i);
        expect(command).not.toContain('/ignored');
    });

    it.each(['file:///tmp/bridge', 'javascript:alert(1)', 'not a URL'])('Установщик отклоняет адрес %s', origin => {
        expect(() => bridgeInstallerCommand(origin, false)).toThrow();
    });

    it.skipIf(process.platform === 'win32')('Bash передаёт origin с кавычками буквально, без обращения в сеть', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-installer-command-'));
        try {
            const binary = path.join(temporary, 'bin'); await mkdir(binary);
            const argumentsFile = path.join(temporary, 'arguments');
            await writeFile(path.join(binary, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$QA_CONNECT_ARGS"\nprintf \'%s\\n\' \'exit 0\'\n', { mode: 0o755 });
            const origin = "https://panel'$(false)'.example.test";
            const result = spawnSync('/bin/bash', ['-c', bridgeInstallerCommand(origin, false, true)], {
                env: { ...process.env, PATH: `${binary}${path.delimiter}${process.env.PATH ?? ''}`, QA_CONNECT_ARGS: argumentsFile },
                encoding: 'utf8', timeout: 5000,
            });
            expect(result.status, result.stderr).toBe(0);
            expect((await readFile(argumentsFile, 'utf8')).trim().split('\n')).toEqual([
                '-fsSL', `${origin}/api/bridge/install.sh?reconnect=1`,
            ]);
        } finally { await rm(temporary, { recursive: true, force: true }); }
    });
});
