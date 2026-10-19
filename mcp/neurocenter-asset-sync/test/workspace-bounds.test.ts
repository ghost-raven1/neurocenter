import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindProject, projectFolder, projectBindingId, workspaceReport } from '../src/bridge/workspace.js';
import { readState, stateDir } from '../src/bridge/state.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { install } from '../src/bridge/installer.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';

describe('Конечное чтение привязки проекта и приватных JSON-настроек', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const marker = () => path.join(fixture.root, '.opencode/neurocenter.json');
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it('Действительная привязка сохраняет прежний ID и fingerprint', async () => {
        expect(await projectFolder('test-project')).toBe(fixture.root);
        expect(await projectBindingId('test-project')).toMatch(/^[a-f0-9]{64}$/);
        const report = await workspaceReport(); expect(report.bindings).toEqual([expect.objectContaining({ projectId: 'test-project', valid: true })]);
    });
    it.each(['{bad', 'null', '[]', '5'])('Повреждённый marker не принимается, не переписывается и не блокирует heartbeat: %s', async text => {
        await fs.writeFile(marker(), text); const before = await fs.stat(marker());
        const mutations = [vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'mkdir'), vi.spyOn(fs, 'rename'), vi.spyOn(fs, 'rm')];
        await expect(projectFolder('test-project')).rejects.toThrow('повреждена');
        await expect(projectBindingId('test-project')).rejects.toThrow('повреждена');
        await expect(bindProject('test-project', path.basename(fixture.root))).rejects.toThrow();
        expect((await workspaceReport()).bindings).toEqual([expect.objectContaining({ projectId: 'test-project', valid: false })]);
        for (const mutation of mutations) { expect(mutation).not.toHaveBeenCalled(); }
        expect(await fs.readFile(marker(), 'utf8')).toBe(text); expect((await fs.stat(marker())).mtimeMs).toBe(before.mtimeMs);
    });
    it('Marker больше 64 КиБ отклоняется до открытия содержимого, включая валидный JSON', async () => {
        const content = ' '.repeat(64 * 1024) + await fs.readFile(marker(), 'utf8'); await fs.writeFile(marker(), content);
        const before = await fs.stat(marker()); const open = vi.spyOn(fs, 'open');
        await expect(projectFolder('test-project')).rejects.toThrow('повреждена');
        await expect(bindProject('test-project', path.basename(fixture.root))).rejects.toThrow('повреждена');
        expect(open.mock.calls.some(([file]) => String(file) === marker())).toBe(false);
        expect((await workspaceReport()).bindings[0]?.valid).toBe(false);
        expect((await fs.stat(marker())).mtimeMs).toBe(before.mtimeMs);
    });
    it.skipIf(process.platform === 'win32')('Настоящий FIFO вместо marker не удерживает scanner, bindProject и heartbeat', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, async () => undefined, async () => undefined);
        await fs.rm(marker()); execFileSync('mkfifo', [marker()]);
        const before = await fs.lstat(marker()); const open = vi.spyOn(fs, 'open'); const start = Date.now();
        await expect(inspectInstallation('test-project', pkg)).rejects.toThrow('повреждена');
        await expect(bindProject('test-project', path.basename(fixture.root))).rejects.toThrow('повреждена');
        expect((await workspaceReport()).bindings[0]?.valid).toBe(false);
        expect(Date.now() - start).toBeLessThan(1000);
        expect(open.mock.calls.some(([file]) => String(file) === marker())).toBe(false);
        const after = await fs.lstat(marker()); expect(after.isFIFO()).toBe(true); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
    });
    it('Симлинк вместо marker не читает внешний JSON', async () => {
        const outside = path.join(fixture.temporary, 'внешняя-привязка.json'); await fs.writeFile(outside, await fs.readFile(marker()));
        await fs.rm(marker()); await fs.symlink(outside, marker()); const open = vi.spyOn(fs, 'open');
        await expect(projectFolder('test-project')).rejects.toThrow('повреждена');
        expect(open.mock.calls.some(([file]) => String(file) === outside || String(file) === marker())).toBe(false);
        expect((await fs.lstat(marker())).isSymbolicLink()).toBe(true);
    });
    it('Приватный JSON больше 1 МиБ отклоняется без чтения и изменения файла', async () => {
        const file = path.join(stateDir(), 'workspace.json'); const raw = ' '.repeat(1048576) + await fs.readFile(file, 'utf8');
        await fs.writeFile(file, raw); const before = await fs.stat(file); const open = vi.spyOn(fs, 'open');
        await expect(readState('workspace')).rejects.toThrow('Повреждена локальная настройка MCP: workspace');
        await expect(workspaceReport()).rejects.toThrow('Повреждена локальная настройка MCP: workspace');
        expect(open.mock.calls.some(([candidate]) => String(candidate) === file)).toBe(false);
        expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
    });
    it.skipIf(process.platform === 'win32')('Настоящий FIFO workspace.json не блокирует worker heartbeat или scanner', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, async () => undefined, async () => undefined);
        const file = path.join(stateDir(), 'workspace.json'); await fs.rm(file); execFileSync('mkfifo', [file]);
        const before = await fs.lstat(file); const open = vi.spyOn(fs, 'open'); const start = Date.now();
        await expect(readState('workspace')).rejects.toThrow('Повреждена локальная настройка MCP: workspace');
        await expect(workspaceReport()).rejects.toThrow('Повреждена локальная настройка MCP: workspace');
        await expect(inspectInstallation('test-project', pkg)).rejects.toThrow('Повреждена локальная настройка MCP: workspace');
        expect(Date.now() - start).toBeLessThan(1000);
        expect(open.mock.calls.some(([candidate]) => String(candidate) === file)).toBe(false);
        const after = await fs.lstat(file); expect(after.isFIFO()).toBe(true); expect(after.ino).toBe(before.ino); expect(after.mtimeMs).toBe(before.mtimeMs);
    });
    it('Отсутствующая приватная настройка по-прежнему возвращает undefined', async () => {
        expect(await readState('missing')).toBeUndefined();
    });
});
