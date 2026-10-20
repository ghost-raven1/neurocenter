import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { install, installSet } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { assetBase, assetKey, mcpConfigKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { writeState } from '../src/bridge/state.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';
import { rehashPackage, setFixture, setPackage } from './install-set-fixture.js';
import type { Package } from '../src/bridge/package.js';

describe('Проверка известной установки без записи и запуска кода', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const noop = async () => undefined;
    const target = (pkg: Package) => path.join(fixture.root, assetBase(pkg), pkg.files[0]!.path);
    const receipt = (pkg: Package) => path.join(fixture.root, receiptPath(pkg));
    async function snapshot(root: string): Promise<Record<string, { hash: string; mtime: number }>> {
        const result: Record<string, { hash: string; mtime: number }> = {};
        const walk = async (directory: string): Promise<void> => {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
                const file = path.join(directory, entry.name);
                if (entry.isDirectory()) { await walk(file); }
                else if (entry.isFile()) { result[path.relative(root, file)] = { hash: hash(await fs.readFile(file)), mtime: (await fs.stat(file)).mtimeMs }; }
            }
        };
        await walk(root); return result;
    }
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it.each(['skill', 'mcp', 'plugin'])('Сверяет настоящий пакет %s и сохраняет байты и mtime всех файлов', async kind => {
        const pkg = packageFixture(kind);
        await fs.writeFile(path.join(fixture.root, 'opencode.json'), '{"privateNote":"НЕЛЬЗЯ_ОТПРАВЛЯТЬ_СЕКРЕТ"}');
        await install('test-project', pkg, noop, noop);
        const foreign = path.join(path.dirname(target(pkg)), 'личный-файл.txt'); await fs.writeFile(foreign, 'ЛИЧНЫЙ_ФАЙЛ');
        const before = await snapshot(fixture.temporary);
        const mutations = [vi.spyOn(fs, 'writeFile'), vi.spyOn(fs, 'mkdir'), vi.spyOn(fs, 'rm'), vi.spyOn(fs, 'rename'), vi.spyOn(fs, 'unlink'), vi.spyOn(fs, 'appendFile'), vi.spyOn(fs, 'truncate')];
        const open = vi.spyOn(fs, 'open');
        const result = await inspectInstallation('test-project', pkg);
        expect(result).toMatchObject({ schemaVersion: 1, projectId: 'test-project', assetId: pkg.plugin.id, assetKind: kind,
            version: 1, manifest: pkg.manifest.sha256, state: 'checked', status: 'synced', readiness: 'unverified', issues: [] });
        expect(result.bindingId).toMatch(/^[a-f0-9]{64}$/); expect(Date.parse(result.checkedAt)).toBeGreaterThan(0);
        for (const mutation of mutations) { expect(mutation).not.toHaveBeenCalled(); }
        expect(open.mock.calls.some(([file]) => String(file) === foreign)).toBe(false);
        expect(await snapshot(fixture.temporary)).toEqual(before);
        const text = JSON.stringify(result);
        for (const secret of ['НЕЛЬЗЯ_ОТПРАВЛЯТЬ_СЕКРЕТ', 'ЛИЧНЫЙ_ФАЙЛ', fixture.root, process.execPath, pkg.files[0]!.content]) { expect(text).not.toContain(secret); }
        expect(Buffer.byteLength(text)).toBeLessThan(8500);
    });
    it('Проверяет общую транзитивную зависимость по замороженному пакету', async () => {
        const shared = setPackage('shared'); const dependency = setPackage('dep', 'mcp', 1, [shared]);
        const root = setPackage('root', 'skill', 1, [dependency]);
        await installSet('test-project', setFixture(root, [dependency, shared]), noop, noop);
        for (const pkg of [root, dependency, shared]) { expect((await inspectInstallation('test-project', pkg)).status).toBe('synced'); }
        await uninstall('test-project', root, noop, noop);
        for (const pkg of [dependency, shared]) { expect((await inspectInstallation('test-project', pkg)).status).toBe('synced'); }
    });
    it('Не импортирует исполняемый плагин с побочным эффектом', async () => {
        const pkg = setPackage('never-run', 'plugin'); const marker = path.join(fixture.temporary, 'ВЫПОЛНЕНО');
        const content = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'Запущено'); throw new Error('Код нельзя исполнять при проверке');`;
        pkg.files[0] = { ...pkg.files[0]!, content, size: Buffer.byteLength(content), sha256: hash(content) }; rehashPackage(pkg);
        await install('test-project', pkg, noop, noop);
        expect((await inspectInstallation('test-project', pkg)).status).toBe('synced');
        await expect(fs.access(marker)).rejects.toThrow();
    });
    it('Обнаруживает ручную правку и согласованную подмену файлов с локальной квитанцией', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        await fs.writeFile(target(pkg), 'Ручная правка');
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'modified', issues: ['file-modified'] });
        const value = JSON.parse(await fs.readFile(receipt(pkg), 'utf8')); value.files[assetBase(pkg) + '/' + pkg.files[0]!.path] = hash('Ручная правка');
        await fs.writeFile(receipt(pkg), JSON.stringify(value));
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'modified', issues: ['file-modified', 'receipt-mismatch'] });
    });
    it('Подмена receipt и ledger не подтверждает другой серверный manifest', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const value = JSON.parse(await fs.readFile(receipt(pkg), 'utf8')); value.manifest = 'f'.repeat(64); await fs.writeFile(receipt(pkg), JSON.stringify(value));
        const ledger = JSON.parse(await fs.readFile(path.join(fixture.root, LEDGER_PATH), 'utf8'));
        ledger.roots[assetKey(pkg)].root.manifest = 'f'.repeat(64); ledger.roots[assetKey(pkg)].packages[0].manifest = 'f'.repeat(64); ledger.roots[assetKey(pkg)].manifest = 'f'.repeat(64);
        await fs.writeFile(path.join(fixture.root, LEDGER_PATH), JSON.stringify(ledger));
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('unknown'); expect(result.issues).toContain('ledger-mismatch'); expect(result.issues).toContain('receipt-mismatch');
    });
    it('Различает отсутствующий файл, отсутствующую квитанцию и повреждённый JSON', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        await fs.rm(target(pkg));
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'missing', issues: ['file-missing'] });
        await fs.writeFile(target(pkg), pkg.files[0]!.content); await fs.rm(receipt(pkg));
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'missing', issues: ['receipt-missing'] });
        await fs.writeFile(receipt(pkg), '{ секретный сломанный JSON');
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'unknown', issues: ['receipt-invalid'] });
    });
    it.each(['missing', 'invalid', 'mismatch'])('Обнаруживает состояние ledger: %s', async state => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const file = path.join(fixture.root, LEDGER_PATH);
        if (state === 'missing') { await fs.rm(file); }
        else if (state === 'invalid') { await fs.writeFile(file, '{"schemaVersion":1,"roots":null}'); }
        else { const value = JSON.parse(await fs.readFile(file, 'utf8')); value.roots[assetKey(pkg)].packages[0].manifest = 'f'.repeat(64); value.roots[assetKey(pkg)].root.manifest = 'f'.repeat(64); value.roots[assetKey(pkg)].manifest = 'f'.repeat(64); await fs.writeFile(file, JSON.stringify(value)); }
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ status: 'unknown', issues: ['ledger-' + state] });
    });
    it('Пересчитывает graph manifest реестра и отклоняет лишние связи', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]);
        await installSet('test-project', setFixture(root, [dep]), noop, noop);
        const file = path.join(fixture.root, LEDGER_PATH); const value = JSON.parse(await fs.readFile(file, 'utf8'));
        value.roots[assetKey(root)].manifest = 'f'.repeat(64); await fs.writeFile(file, JSON.stringify(value));
        expect(await inspectInstallation('test-project', root)).toMatchObject({ status: 'unknown', issues: ['ledger-invalid'] });
    });
    it.each(['files.lock', 'pending.json', 'recovery.lock'])('Возвращает busy и не восстанавливает даже оставленный %s', async name => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const file = name === 'files.lock' ? path.join(fixture.root, '.opencode/neurocenter/files.lock') : path.join(stateDir(), 'file-changes', hash(fixture.root), name);
        await fs.writeFile(file, '{"pid":99999999,"state":"prepared","changes":[]}');
        const before = await snapshot(fixture.temporary);
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ state: 'busy', status: 'unknown', issues: ['inspection-busy'] });
        expect(await snapshot(fixture.temporary)).toEqual(before);
    });
    it('Не следует за симлинком и не читает внешний секрет', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const outside = path.join(fixture.temporary, 'внешний-секрет.txt'); await fs.writeFile(outside, 'ВНЕШНИЙ_СЕКРЕТ');
        await fs.rm(target(pkg)); await fs.symlink(outside, target(pkg));
        const open = vi.spyOn(fs, 'open'); const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('unknown'); expect(result.issues).toContain('file-unsafe');
        expect(open.mock.calls.some(([file]) => String(file) === outside || String(file) === target(pkg))).toBe(false);
        expect(JSON.stringify(result)).not.toContain(outside); expect(JSON.stringify(result)).not.toContain('ВНЕШНИЙ_СЕКРЕТ');
    });
    it.skipIf(process.platform === 'win32')('FIFO вместо управляемого файла не блокирует проверку', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop); await fs.rm(target(pkg));
        execFileSync('mkfifo', [target(pkg)]);
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('unknown'); expect(result.issues).toContain('file-unsafe');
    });
    it.each(['receipt', 'ledger', 'file', 'config'])('Ограничивает размер читаемого %s до чтения содержимого', async type => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop);
        const file = type === 'receipt' ? receipt(pkg) : type === 'ledger' ? path.join(fixture.root, LEDGER_PATH)
            : type === 'file' ? target(pkg) : path.join(fixture.root, 'opencode.json');
        await fs.truncate(file, (type === 'receipt' ? 256 * 1024 : type === 'ledger' ? 4 * 1048576 : 1048576) + 1);
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('unknown'); expect(result.issues).toContain('limit-exceeded');
    });
    it.each(['missing', 'invalid', 'modified'])('Распознаёт состояние JSONC: %s', async state => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop);
        const file = path.join(fixture.root, 'opencode.json');
        if (state === 'missing') { await fs.rm(file); }
        else if (state === 'invalid') { await fs.writeFile(file, '{"mcp":'); }
        else { const value = JSON.parse(await fs.readFile(file, 'utf8')); value.mcp[mcpConfigKey(pkg)].enabled = false; await fs.writeFile(file, JSON.stringify(value)); }
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe(state === 'missing' ? 'missing' : state === 'invalid' ? 'unknown' : 'modified');
        expect(result.issues).toContain('config-' + state);
    });
    it('Согласованная подмена подключения в receipt и JSONC не становится synced', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop);
        const value = JSON.parse(await fs.readFile(receipt(pkg), 'utf8')); value.config.value.environment = { TOKEN: 'ТАЙНЫЙ_ТОКЕН' };
        await fs.writeFile(receipt(pkg), JSON.stringify(value));
        const configFile = path.join(fixture.root, 'opencode.json'); const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        config.mcp[mcpConfigKey(pkg)] = value.config.value; await fs.writeFile(configFile, JSON.stringify(config));
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('modified'); expect(result.issues).toContain('receipt-mismatch'); expect(result.issues).toContain('config-modified');
        expect(JSON.stringify(result)).not.toContain('ТАЙНЫЙ_ТОКЕН');
    });
    it('Произвольный прежний absolute executable остаётся runtime unverified', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop);
        const value = JSON.parse(await fs.readFile(receipt(pkg), 'utf8')); value.config.value.command[0] = '/tmp/никогда-не-запускать';
        await fs.writeFile(receipt(pkg), JSON.stringify(value));
        const configFile = path.join(fixture.root, 'opencode.json'); const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
        config.mcp[mcpConfigKey(pkg)] = value.config.value; await fs.writeFile(configFile, JSON.stringify(config));
        expect(await inspectInstallation('test-project', pkg)).toMatchObject({ state: 'checked', status: 'unknown', issues: ['runtime-path-unverified'], readiness: 'unverified' });
    });
    it('Два подключения одного инструмента в разных конфигурациях считаются неоднозначными', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop);
        await fs.writeFile(path.join(fixture.root, '.opencode/opencode.jsonc'), await fs.readFile(path.join(fixture.root, 'opencode.json')));
        const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('unknown'); expect(result.issues).toContain('config-ambiguous');
    });
    it('Повреждённые пути квитанции не заставляют читать соседние файлы', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const outside = path.join(fixture.temporary, 'секрет.txt'); await fs.writeFile(outside, 'НЕ_ЧИТАТЬ');
        const value = JSON.parse(await fs.readFile(receipt(pkg), 'utf8')); value.files['../../секрет.txt'] = hash('НЕ_ЧИТАТЬ');
        await fs.writeFile(receipt(pkg), JSON.stringify(value));
        const open = vi.spyOn(fs, 'open'); const result = await inspectInstallation('test-project', pkg);
        expect(result.status).toBe('modified'); expect(result.issues).toContain('receipt-mismatch');
        expect(open.mock.calls.some(([file]) => String(file) === outside)).toBe(false);
    });
    it.each(['lock', 'receipt', 'binding'])('Гонка во время чтения возвращает busy: %s', async type => {
        const pkg = packageFixture(); await install('test-project', pkg, noop, noop);
        const open = fs.open.bind(fs); let injected = false;
        vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
            if (!injected && String(file) === target(pkg)) {
                injected = true;
                if (type === 'lock') { await fs.writeFile(path.join(fixture.root, '.opencode/neurocenter/files.lock'), 'Другой процесс'); }
                else if (type === 'receipt') {
                    const temporary = receipt(pkg) + '.changed'; await fs.writeFile(temporary, await fs.readFile(receipt(pkg))); await fs.rename(temporary, receipt(pkg));
                } else {
                    const other = path.join(fixture.temporary, 'другая-папка'); await fs.mkdir(path.join(other, '.opencode'), { recursive: true });
                    await fs.writeFile(path.join(other, '.opencode/neurocenter.json'), await fs.readFile(path.join(fixture.root, '.opencode/neurocenter.json')));
                    await writeState('workspace', { root: fixture.temporary, bindings: { 'test-project': other } });
                }
            }
            return open(file, flags, mode);
        });
        const result = await inspectInstallation('test-project', pkg);
        expect(result.state).toBe('busy'); expect(result.status).toBe('unknown');
        expect(result.issues).toEqual([type === 'lock' ? 'inspection-busy' : type === 'binding' ? 'binding-changed' : 'snapshot-changed']);
    });
});
