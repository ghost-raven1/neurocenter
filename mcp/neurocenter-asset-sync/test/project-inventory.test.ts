import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture, packageFixture } from './bridge-fixture.js';
import { prepareAdoptInstallation } from '../src/bridge/adopt-installation.js';
import { scanProjectInventory } from '../src/bridge/project-inventory.js';
import { assetBase, receiptPath } from '../src/bridge/installation-receipt.js';
import { stateDir } from '../src/bridge/state.js';
import { install } from '../src/bridge/installer.js';
import { InventoryReader } from '../src/bridge/project-inventory-reader.js';
import { readInventoryScan } from '../src/bridge/project-inventory-storage.js';
import { noop, unmanaged, bytesAndTimes } from './project-inventory-fixture.js';

describe('Проектная инвентаризация без запуска кода', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it('Публичный результат содержит только metadata, а полный снимок закрыт и действует 15 минут', async () => {
        const pkg = packageFixture('mcp'); await unmanaged(fixture.root, pkg);
        await fs.writeFile(path.join(fixture.root, 'opencode.jsonc'), (await fs.readFile(path.join(fixture.root, 'opencode.jsonc'), 'utf8')).replace('"mcp"', '"secret":"НЕ_ПЕРЕДАВАТЬ", "mcp"'));
        const before = await bytesAndTimes(fixture.root, pkg); const authorize = vi.fn(noop);
        const result = await scanProjectInventory('test-project', authorize);
        expect(result).toMatchObject({ schemaVersion: 1, complete: true, issues: [] }); expect(authorize).toHaveBeenCalledTimes(2);
        expect(result.entries.some(entry => entry.path === assetBase(pkg) && entry.state === 'unmanaged')).toBe(true);
        expect(Date.parse(result.expiresAt) - Date.parse(result.checkedAt)).toBe(15 * 60000);
        expect(Object.keys(result).sort()).toEqual(['schemaVersion', 'projectId', 'bindingId', 'instanceId', 'scanId', 'digest', 'checkedAt', 'expiresAt', 'complete', 'issues', 'entries'].sort());
        for (const entry of result.entries) { expect(Object.keys(entry).sort()).toEqual(['candidateId', 'kind', 'path', 'state', 'reason'].sort()); }
        for (const secret of ['НЕ_ПЕРЕДАВАТЬ', fixture.root, process.execPath, 'command', 'environment']) { expect(JSON.stringify(result)).not.toContain(secret); }
        expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before);
        const stored = path.join(stateDir(), 'project-inventory', result.scanId + '.json');
        if (process.platform !== 'win32') { expect((await fs.stat(stored)).mode & 0o777).toBe(0o600); }
        expect((await readInventoryScan(result.scanId)).summary).toEqual(result);
    });
    it('Различает управляемые и изменённые локальные файлы', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        expect((await scanProjectInventory('test-project', noop)).entries.find(entry => entry.path === assetBase(pkg))).toMatchObject({ state: 'managed', reason: 'managed-receipt' });
        await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'ручная правка');
        expect((await scanProjectInventory('test-project', noop)).entries.find(entry => entry.path === assetBase(pkg))).toMatchObject({ state: 'damaged', reason: 'file-mismatch' });
    });
    it('Повреждённая квитанция делает снимок неполным, не маскируя проблему', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop); await fs.writeFile(path.join(fixture.root, receiptPath(pkg)), '{broken');
        const result = await scanProjectInventory('test-project', noop); expect(result.complete).toBe(false); expect(result.issues).toContain('receipt-invalid');
    });
    it('Симлинк на чужой каталог отмечается unsafe без чтения его содержимого', async () => {
        const outside = path.join(fixture.temporary, 'чужой'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'SKILL.md'), 'СЕКРЕТ_СНАРУЖИ');
        await fs.mkdir(path.join(fixture.root, '.opencode/skills'), { recursive: true }); await fs.symlink(outside, path.join(fixture.root, '.opencode/skills/escape'));
        const read = vi.spyOn(fs, 'open'); const result = await scanProjectInventory('test-project', noop);
        expect(result).toMatchObject({ complete: false, issues: expect.arrayContaining(['unsafe-path']) });
        expect(result.entries).toContainEqual(expect.objectContaining({ path: '.opencode/skills/escape', state: 'unsafe', reason: 'unsafe-path' }));
        expect(read.mock.calls.some(([file]) => String(file).includes(outside))).toBe(false); expect(JSON.stringify(result)).not.toContain('СЕКРЕТ_СНАРУЖИ');
    });
    it.runIf(process.platform !== 'win32')('Настоящий FIFO не открывается и не блокирует сканирование', async () => {
        const pkg = packageFixture(); const folder = path.join(fixture.root, assetBase(pkg)); await fs.mkdir(folder, { recursive: true }); execFileSync('mkfifo', [path.join(folder, 'SKILL.md')]);
        const result = await scanProjectInventory('test-project', noop);
        expect(result.entries).toContainEqual(expect.objectContaining({ path: assetBase(pkg), state: 'unsafe', reason: 'unsafe-path' })); expect(result.complete).toBe(false);
    });
    it('Файл больше 1 МиБ не читается и отмечается ограничением', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); await fs.truncate(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 1048577);
        const result = await scanProjectInventory('test-project', noop); expect(result.complete).toBe(false); expect(result.issues).toContain('read-limit');
        expect(result.entries).toContainEqual(expect.objectContaining({ state: 'unreadable', reason: 'read-limit' }));
    });
    it('Отказ чтения возвращает фиксированную причину без сырой ошибки с путём', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const original = fs.open.bind(fs);
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => { if (String(args[0]).endsWith('SKILL.md')) { throw Object.assign(new Error('SECRET/' + fixture.root), { code: 'EACCES' }); } return original(...args); });
        const result = await scanProjectInventory('test-project', noop); expect(result.complete).toBe(false); expect(result.issues).toContain('read-failed'); expect(JSON.stringify(result)).not.toContain('SECRET');
    });
    it('После 200 кандидатов явно сообщает о неполном результате', async () => {
        const folder = path.join(fixture.root, '.opencode/skills'); await fs.mkdir(folder, { recursive: true });
        for (let index = 0; index < 201; index++) { await fs.mkdir(path.join(folder, 'skill-' + index)); }
        const result = await scanProjectInventory('test-project', noop); expect(result.entries).toHaveLength(200); expect(result.complete).toBe(false); expect(result.issues).toContain('entry-limit');
    });
    it('Проектный lock не восстанавливается и не удаляется сканером', async () => {
        const file = path.join(fixture.root, '.opencode/neurocenter/files.lock'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'чужой активный lock');
        const result = await scanProjectInventory('test-project', noop); expect(result).toMatchObject({ complete: false, entries: [], issues: ['project-busy'] }); expect(await fs.readFile(file, 'utf8')).toBe('чужой активный lock');
    });
    it('Глобальный профиль и исполняемые файлы не запускаются и не входят в обход', async () => {
        const marker = path.join(fixture.temporary, 'ЗАПУСК_ЗАПРЕЩЁН'); const pkg = packageFixture('plugin');
        pkg.files[0]!.content = `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`;
        await unmanaged(fixture.root, pkg);
        const global = path.join(fixture.temporary, 'глобальный-профиль'); await fs.mkdir(global); await fs.writeFile(path.join(global, 'opencode.json'), 'СЕКРЕТ_ГЛОБАЛЬНЫЙ');
        vi.stubEnv('OPENCODE_CONFIG_DIR', global); const result = await scanProjectInventory('test-project', noop);
        expect(result.complete).toBe(true); expect(JSON.stringify(result)).not.toContain(global); await expect(fs.access(marker)).rejects.toThrow();
    });
    it('Новый файл после снимка обнаруживается даже при прежних байтах существующих файлов', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const reader = new InventoryReader(fixture.root); await reader.tree(assetBase(pkg));
        await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'новый.txt'), 'не был просмотрен'); await expect(reader.verify()).rejects.toThrow('snapshot-changed');
    });
    it('Квота приватных снимков останавливает новый scan без изменения проекта', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); await scanProjectInventory('test-project', noop);
        const extra = path.join(stateDir(), 'project-inventory', 'старый-снимок'); await fs.writeFile(extra, ''); await fs.truncate(extra, 64 * 1048576);
        const before = await bytesAndTimes(fixture.root, pkg); await expect(scanProjectInventory('test-project', noop)).rejects.toThrow('64 МиБ'); expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before);
    });
    it('Слишком длинный MCP key даёт неполный scan с read-limit, без selector или присвоения', async () => {
        const pkg = packageFixture('mcp'); await unmanaged(fixture.root, pkg); const key = 'НЕ_ПЕРЕДАВАТЬ_' + 'x'.repeat(2048);
        await fs.writeFile(path.join(fixture.root, 'opencode.jsonc'), JSON.stringify({ mcp: { [key]: { command: ['личная-команда'] } } }));
        const result = await scanProjectInventory('test-project', noop); expect(result.complete).toBe(false); expect(result.issues).toContain('read-limit');
        const candidate = result.entries.find(entry => entry.path === 'opencode.jsonc')!; expect(candidate).toMatchObject({ state: 'unreadable', reason: 'read-limit' });
        expect(JSON.stringify(result)).not.toContain('НЕ_ПЕРЕДАВАТЬ'); expect(JSON.stringify(result)).not.toContain('личная-команда');
        expect(Object.values((await readInventoryScan(result.scanId)).selectors)).not.toContain('mcp:' + key);
        await expect(prepareAdoptInstallation('test-project', pkg, undefined, { scanId: result.scanId, candidateId: candidate.candidateId, digest: result.digest }, noop)).rejects.toThrow();
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });

});
