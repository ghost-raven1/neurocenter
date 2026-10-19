import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture, packageFixture } from './bridge-fixture.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { applyAdoptInstallation, prepareAdoptInstallation } from '../src/bridge/adopt-installation.js';
import { scanProjectInventory } from '../src/bridge/project-inventory.js';
import { install } from '../src/bridge/installer.js';
import { uninstall } from '../src/bridge/uninstaller.js';
import { applyLocalChange } from '../src/bridge/local-change-plan.js';
import { setFixture, setPackage, rehashPackage } from './install-set-fixture.js';
import { expectedAdoptConnection } from '../src/bridge/project-inventory-config.js';
import { readLocalChangePlan } from '../src/bridge/local-change-plan-storage.js';
import { adoptPreview, bytesAndTimes, noop, unmanaged } from './project-inventory-fixture.js';

describe('Точное принятие локальных инструментов', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    beforeEach(async () => { fixture = await workspaceFixture(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    it.each(['skill', 'mcp', 'plugin'])('Принимает %s только через отдельный план, сохраняя inode, байты и mtime исходников и JSONC', async kind => {
        const pkg = packageFixture(kind); await unmanaged(fixture.root, pkg); const before = await bytesAndTimes(fixture.root, pkg);
        const { summary } = await adoptPreview(fixture.root, pkg);
        expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before);
        expect(summary.files.every(file => file.path.startsWith('.opencode/neurocenter/'))).toBe(true);
        expect(await readLocalChangePlan(summary.planId)).toMatchObject({ purpose: 'adopt' });
        const authorize = vi.fn(noop);
        const result = await applyAdoptInstallation('test-project', pkg, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId }, authorize, noop);
        expect(result).toMatchObject({ changePlanId: summary.planId, digest: summary.digest, readiness: 'unverified', changed: true });
        expect(authorize).toHaveBeenCalledTimes(2); expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before);
        expect(JSON.parse(await fs.readFile(path.join(fixture.root, receiptPath(pkg)), 'utf8')).manifest).toBe(pkg.manifest.sha256);
        const scan = await scanProjectInventory('test-project', noop); expect(scan.complete).toBe(true);
        expect(scan.entries.find(entry => entry.path === assetBase(pkg))?.state).toBe('managed');
    });
    it.each(['extra-file', 'extra-directory', 'modified', 'missing'])('Не принимает исходники с отличием %s', async variant => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const base = path.join(fixture.root, assetBase(pkg));
        if (variant === 'extra-file') { await fs.writeFile(path.join(base, 'лишний.txt'), 'чужой'); }
        if (variant === 'extra-directory') { await fs.mkdir(path.join(base, 'лишняя-папка')); }
        if (variant === 'modified') { await fs.writeFile(path.join(base, 'SKILL.md'), 'изменено'); }
        if (variant === 'missing') { await fs.unlink(path.join(base, 'SKILL.md')); }
        await expect(adoptPreview(fixture.root, pkg)).rejects.toThrow(); await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it('Не принимает файлы за пределами canonical layout даже при полном совпадении байтов', async () => {
        const pkg = packageFixture('plugin'); await unmanaged(fixture.root, pkg);
        const manual = path.join(fixture.root, '.opencode/plugins'); await fs.mkdir(manual, { recursive: true }); await fs.writeFile(path.join(manual, 'manual.mjs'), pkg.files[0]!.content);
        const scan = await scanProjectInventory('test-project', noop); const candidate = scan.entries.find(entry => entry.path === '.opencode/plugins/manual.mjs')!;
        await expect(prepareAdoptInstallation('test-project', pkg, undefined, { scanId: scan.scanId, candidateId: candidate.candidateId, digest: scan.digest }, noop)).rejects.toThrow('Кандидат');
    });
    it('Новый или изменённый файл после scan требует новой инвентаризации', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const scan = await scanProjectInventory('test-project', noop);
        await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'новый.txt'), 'ручной');
        await expect(prepareAdoptInstallation('test-project', pkg, undefined, { scanId: scan.scanId, candidateId: scan.entries[0]!.candidateId, digest: scan.digest }, noop)).rejects.toThrow('snapshot-changed');
    });
    it.each(['file', 'config', 'new-file'])('CAS после preview сохраняет ручное изменение %s и не создаёт metadata', async variant => {
        const pkg = packageFixture('mcp'); await unmanaged(fixture.root, pkg); const { summary } = await adoptPreview(fixture.root, pkg);
        if (variant === 'file') { await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'index.mjs'), 'ручной вариант'); }
        if (variant === 'config') { await fs.appendFile(path.join(fixture.root, 'opencode.jsonc'), '// новый комментарий'); }
        if (variant === 'new-file') { await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'новый.txt'), 'не просмотрен'); }
        await expect(applyAdoptInstallation('test-project', pkg, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId }, noop, noop)).rejects.toThrow();
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it('Повторная авторизация перед commit защищает от изменения во время подтверждения', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const { summary } = await adoptPreview(fixture.root, pkg); let calls = 0;
        const authorize = async () => { if (++calls === 2) { await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'изменение при approval'); } };
        await expect(applyAdoptInstallation('test-project', pkg, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId }, authorize, noop)).rejects.toThrow();
        expect(calls).toBe(2); expect(await fs.readFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'utf8')).toBe('изменение при approval');
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it.each(['digest', 'binding', 'expired', 'package'])('Отклоняет устаревшее или чужое подтверждение %s', async variant => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const { summary } = await adoptPreview(fixture.root, pkg);
        const options = { planId: summary.planId, revision: 1 as const, digest: summary.digest, expectedBindingId: summary.bindingId };
        if (variant === 'digest') { options.digest = '0'.repeat(64); }
        if (variant === 'binding') { options.expectedBindingId = '0'.repeat(64); }
        if (variant === 'expired') { vi.setSystemTime(Date.now() + 16 * 60000); }
        await expect(applyAdoptInstallation('test-project', variant === 'package' ? packageFixture('skill', 2) : pkg, options, noop, noop)).rejects.toThrow();
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it('Истёкший scan нельзя использовать для нового плана', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const scan = await scanProjectInventory('test-project', noop); vi.setSystemTime(Date.now() + 16 * 60000);
        await expect(prepareAdoptInstallation('test-project', pkg, undefined, { scanId: scan.scanId, candidateId: scan.entries[0]!.candidateId, digest: scan.digest }, noop)).rejects.toThrow('истёк');
    });
    it('Не подменяет существующую повреждённую или потерянную квитанцию', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, noop, noop); const file = path.join(fixture.root, receiptPath(pkg)); await fs.unlink(file);
        const scan = await scanProjectInventory('test-project', noop);
        expect(scan.entries.find(entry => entry.path === assetBase(pkg))).toMatchObject({ state: 'damaged', reason: 'receipt-missing' });
        await expect(adoptPreview(fixture.root, pkg)).rejects.toThrow(); await expect(fs.access(file)).rejects.toThrow();
    });
    it.each(['different', 'duplicate-config', 'duplicate-key', 'different-owner'])('Не угадывает владение MCP при %s', async variant => {
        const pkg = packageFixture('mcp'); await unmanaged(fixture.root, pkg); const file = path.join(fixture.root, 'opencode.jsonc');
        const value = expectedAdoptConnection(fixture.root, pkg); const key = 'neurocenter_' + assetKey(pkg);
        if (variant === 'different') { await fs.writeFile(file, JSON.stringify({ mcp: { [key]: { type: 'local', command: ['ручная-команда'] } } })); }
        if (variant === 'duplicate-config') { await fs.writeFile(path.join(fixture.root, 'opencode.json'), JSON.stringify({ mcp: { [key]: value } })); }
        if (variant === 'duplicate-key') { await fs.writeFile(file, '{"mcp":{' + JSON.stringify(key) + ':' + JSON.stringify(value) + ',' + JSON.stringify(key) + ':' + JSON.stringify(value) + '}}'); }
        if (variant === 'different-owner') { await fs.writeFile(file, JSON.stringify({ mcp: { [key]: value, other: value } })); }
        await expect(adoptPreview(fixture.root, pkg)).rejects.toThrow();
        await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it('Удалённый MCP без файлов принимается только по точному project key', async () => {
        const pkg = setPackage('ai-plug-remote', 'mcp', 1, [], 0); pkg.config = { transport: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'СЕКРЕТ' } }; rehashPackage(pkg);
        await unmanaged(fixture.root, pkg); const before = await fs.readFile(path.join(fixture.root, 'opencode.jsonc'), 'utf8');
        const scan = await scanProjectInventory('test-project', noop); const candidate = scan.entries.find(entry => entry.kind === 'mcp' && entry.path === 'opencode.jsonc')!;
        expect(JSON.stringify(scan)).not.toContain('СЕКРЕТ');
        const summary = await prepareAdoptInstallation('test-project', pkg, undefined, { scanId: scan.scanId, candidateId: candidate.candidateId, digest: scan.digest }, noop);
        await applyAdoptInstallation('test-project', pkg, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId }, noop, noop);
        expect(await fs.readFile(path.join(fixture.root, 'opencode.jsonc'), 'utf8')).toBe(before);
    });
    it('Разные инструменты не могут присвоить одну skill папку', async () => {
        const original = setPackage('ai-plug-first', 'skill'); const other = setPackage('ai-plug-second', 'skill'); other.plugin.name = original.plugin.name; rehashPackage(other);
        await install('test-project', original, noop, noop); await expect(adoptPreview(fixture.root, other)).rejects.toThrow();
    });
    it('Полный граф принимается одной транзакцией; общая зависимость остаётся защищённой владельцем', async () => {
        const shared = setPackage('ai-plug-shared'); const a = setPackage('ai-plug-a', 'mcp', 1, [shared]); const b = setPackage('ai-plug-b', 'plugin', 1, [shared]);
        const root = setPackage('ai-plug-root', 'skill', 1, [a, b]); const set = setFixture(root, [a, b, shared]);
        for (const pkg of set.packages) { await unmanaged(fixture.root, pkg); }
        const before = await Promise.all(set.packages.map(pkg => bytesAndTimes(fixture.root, pkg)));
        const { summary } = await adoptPreview(fixture.root, root, set); expect(summary.manifest).toBe(root.manifest.sha256);
        const result = await applyAdoptInstallation('test-project', root, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId, installSet: set }, noop, noop);
        expect(result.manifest).toBe(set.manifest); expect(result.packages).toHaveLength(4);
        expect(await Promise.all(set.packages.map(pkg => bytesAndTimes(fixture.root, pkg)))).toEqual(before);
        await expect(uninstall('test-project', shared, noop, noop)).rejects.toThrow('зависимость');
        await uninstall('test-project', root, noop, noop); await expect(uninstall('test-project', shared, noop, noop)).rejects.toThrow('зависимость');
        for (const pkg of [a, b, shared]) { await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).resolves.toBeUndefined(); }
    });
    it('Подтверждённая managed зависимость переиспользуется без переписывания её квитанции', async () => {
        const dep = setPackage('ai-plug-managed-dep'); await install('test-project', dep, noop, noop);
        const root = setPackage('ai-plug-manual-root', 'skill', 1, [dep]); await unmanaged(fixture.root, root); const set = setFixture(root, [dep]);
        const file = path.join(fixture.root, receiptPath(dep)); const before = await fs.stat(file, { bigint: true }); const bytes = await fs.readFile(file);
        const { summary } = await adoptPreview(fixture.root, root, set);
        await applyAdoptInstallation('test-project', root, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId, installSet: set }, noop, noop);
        expect(await fs.readFile(file)).toEqual(bytes); expect((await fs.stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    });
    it('Принятие не заменяет закреплённую другим владельцем версию общей зависимости', async () => {
        const dep = setPackage('ai-plug-dep'); await install('test-project', dep, noop, noop);
        const next = setPackage('ai-plug-dep', 'mcp', 2); const root = setPackage('ai-plug-other-root', 'skill', 1, [next]); await unmanaged(fixture.root, root);
        await expect(adoptPreview(fixture.root, root, setFixture(root, [next]))).rejects.toThrow('закреплена');
    });
    it('План adopt не исполняется endpoint восстановления и повторно не применяется', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const { summary } = await adoptPreview(fixture.root, pkg);
        const options = { planId: summary.planId, revision: 1 as const, digest: summary.digest, expectedBindingId: summary.bindingId };
        await expect(applyLocalChange('test-project', pkg, options, noop, noop)).rejects.toThrow();
        await applyAdoptInstallation('test-project', pkg, options, noop, noop);
        await expect(applyAdoptInstallation('test-project', pkg, options, noop, noop)).rejects.toThrow();
    });

    it('ENOSPC после создания первой metadata откатывает все квитанции, сохраняя исходники и JSONC', async () => {
        const dep = setPackage('ai-plug-space-dep'); const root = setPackage('ai-plug-space-root', 'skill', 1, [dep]); const set = setFixture(root, [dep]);
        for (const pkg of set.packages) { await unmanaged(fixture.root, pkg); }
        const before = await Promise.all(set.packages.map(pkg => bytesAndTimes(fixture.root, pkg)));
        const { summary } = await adoptPreview(fixture.root, root, set); const original = fs.link.bind(fs);
        vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
            if (String(destination) === path.join(fixture.root, '.opencode/neurocenter/installations.json')) { throw Object.assign(new Error('Нет места'), { code: 'ENOSPC' }); }
            return original(source, destination);
        });
        await expect(applyAdoptInstallation('test-project', root, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId, installSet: set }, noop, noop)).rejects.toThrow();
        expect(await Promise.all(set.packages.map(pkg => bytesAndTimes(fixture.root, pkg)))).toEqual(before);
        for (const pkg of set.packages) { await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow(); }
    });
    it('Отказ свежей авторизации сохраняет установку без квитанций', async () => {
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg); const { summary } = await adoptPreview(fixture.root, pkg); const before = await bytesAndTimes(fixture.root, pkg);
        let calls = 0; const authorize = async () => { if (++calls === 2) { throw new Error('Доступ отозван'); } };
        await expect(applyAdoptInstallation('test-project', pkg, { planId: summary.planId, revision: 1, digest: summary.digest, expectedBindingId: summary.bindingId }, authorize, noop)).rejects.toThrow('Доступ отозван');
        expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before); await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });
    it('Не выбирает соседнее MCP подключение из того же config вместо указанного кандидата', async () => {
        const pkg = packageFixture('mcp'); await unmanaged(fixture.root, pkg); const file = path.join(fixture.root, 'opencode.jsonc');
        const config = JSON.parse((await fs.readFile(file, 'utf8')).split('\n').slice(1).join('\n')); config.mcp.other = { type: 'remote', url: 'https://other.example.test' }; await fs.writeFile(file, JSON.stringify(config));
        const scan = await scanProjectInventory('test-project', noop); const candidates = scan.entries.filter(entry => entry.path === 'opencode.jsonc'); expect(candidates).toHaveLength(2);
        await expect(prepareAdoptInstallation('test-project', pkg, undefined, { scanId: scan.scanId, candidateId: candidates[1]!.candidateId, digest: scan.digest }, noop)).rejects.toThrow('Выбранное подключение');
    });

    it('Чужая квитанция с case/NFC alias папки блокирует присвоение того же физического payload', async () => {
        const other = setPackage('ai-plug-alias-owner', 'skill'); await install('test-project', other, noop, noop);
        const pkg = packageFixture(); await unmanaged(fixture.root, pkg);
        const file = path.join(fixture.root, receiptPath(other)); const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
        receipt.files = { [assetBase(pkg).replace('.opencode', '.OPENCODE') + '/SKILL.md']: pkg.files[0]!.sha256 }; await fs.writeFile(file, JSON.stringify(receipt));
        const before = await bytesAndTimes(fixture.root, pkg);
        await expect(adoptPreview(fixture.root, pkg)).rejects.toThrow('Каталог уже принадлежит');
        expect(await bytesAndTimes(fixture.root, pkg)).toEqual(before); await expect(fs.access(path.join(fixture.root, receiptPath(pkg)))).rejects.toThrow();
    });

});
