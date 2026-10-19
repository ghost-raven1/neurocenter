import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, modify, applyEdits } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install, installSet } from '../src/bridge/installer.js';
import { prepareLocalChange, applyLocalChange, localChangeReportPath, type LocalChangeSummary } from '../src/bridge/local-change-plan.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { journalDirectory } from '../src/bridge/installation-journal.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { hash, stateDir } from '../src/bridge/state.js';
import { bindProject } from '../src/bridge/workspace.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';
import { setFixture, setPackage } from './install-set-fixture.js';

describe('Явное сравнение и восстановление локальных изменений', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const authorize = vi.fn(async () => undefined); const progress = vi.fn(async () => undefined);
    const read = (relative: string) => fs.readFile(path.join(fixture.root, relative), 'utf8');
    const write = (relative: string, value: string | Buffer) => fs.writeFile(path.join(fixture.root, relative), value);
    const options = (summary: LocalChangeSummary) => ({ planId: summary.planId, revision: 1 as const, digest: summary.digest, expectedBindingId: summary.bindingId });
    const stored = (summary: LocalChangeSummary) => path.join(stateDir(), 'local-change-plans', summary.planId + '.json');
    beforeEach(async () => { fixture = await workspaceFixture(); authorize.mockClear(); progress.mockClear(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });
    async function dirtySkill(value = 'моя ручная правка') {
        const pkg = packageFixture(); await install('test-project', pkg, authorize, progress);
        await write(assetBase(pkg) + '/SKILL.md', value); authorize.mockClear(); progress.mockClear(); return pkg;
    }
    async function editMcp(pkg: ReturnType<typeof packageFixture>, value: unknown) {
        const receipt = JSON.parse(await read(receiptPath(pkg)));
        await write(receipt.config.path, applyEdits(await read(receipt.config.path), modify(await read(receipt.config.path), ['mcp', 'neurocenter_' + assetKey(pkg)], value, {})));
        return receipt;
    }
    it('Сравнение не изменяет проект и не передаёт серверу текст или локальные пути', async () => {
        const secret = '<script>private-token</script>'; const pkg = await dirtySkill(secret);
        const file = path.join(fixture.root, assetBase(pkg), 'SKILL.md'); const before = await fs.stat(file);
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe(secret); expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
        expect(summary.files).toEqual([expect.objectContaining({ path: assetBase(pkg) + '/SKILL.md', operation: 'replace', beforeSha256: hash(secret), afterSha256: pkg.files[0]!.sha256, binary: false })]);
        expect(Object.keys(summary).sort()).toEqual(['schemaVersion', 'planId', 'revision', 'digest', 'projectId', 'bindingId', 'instanceId', 'assetId', 'assetKind', 'version', 'manifest', 'checkedAt', 'expiresAt', 'status', 'files'].sort());
        expect(JSON.stringify(summary)).not.toContain('private-token'); expect(JSON.stringify(summary)).not.toContain(fixture.root); expect(authorize).toHaveBeenCalledTimes(1);
        const report = await localChangeReportPath(summary.planId); const html = await fs.readFile(report, 'utf8');
        expect(html).toContain('&lt;script&gt;private-token&lt;/script&gt;'); expect(html).not.toContain('<script>private-token'); expect(html).toContain("default-src 'none'; script-src 'none'");
        if (process.platform !== 'win32') { expect((await fs.stat(report)).mode & 0o777).toBe(0o600); expect((await fs.stat(stored(summary))).mode & 0o777).toBe(0o600); }
    });
    it('Отдельное применение восстанавливает файл и сохраняет полный ручной вариант в журнале', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        const result = await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        expect(result).toMatchObject({ changePlanId: summary.planId, digest: summary.digest, readiness: 'unverified', manifest: pkg.manifest.sha256 });
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe(pkg.files[0]!.content); expect(authorize).toHaveBeenCalledTimes(2);
        const journal = JSON.parse(await fs.readFile(result.recoveryPath, 'utf8'));
        expect(Buffer.from(journal.changes.find((item: {relative:string}) => item.relative.endsWith('/SKILL.md')).before, 'base64').toString()).toBe('моя ручная правка');
        await expect(applyLocalChange('test-project', pkg, options(summary), authorize, progress)).rejects.toThrow('изменился после сравнения');
    });
    it('Восстанавливает отсутствующий известный файл, сохраняя бинарный вариант без потерь', async () => {
        const pkg = await dirtySkill(); await fs.unlink(path.join(fixture.root, assetBase(pkg), 'SKILL.md'));
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); expect(summary.files[0]!.operation).toBe('add');
        await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        await write(assetBase(pkg) + '/SKILL.md', Buffer.from([0xff, 0x00, 0x80]));
        const binary = await prepareLocalChange('test-project', pkg, undefined, authorize); expect(binary.files[0]).toMatchObject({ binary: true, beforeBytes: 3 });
        const result = await applyLocalChange('test-project', pkg, options(binary), authorize, progress);
        const change = JSON.parse(await fs.readFile(result.recoveryPath, 'utf8')).changes[0]; expect(Buffer.from(change.before, 'base64')).toEqual(Buffer.from([0xff, 0x00, 0x80]));
    });
    it('Уникальный MCP key восстанавливается после preview с сохранением соседних настроек и комментариев', async () => {
        const pkg = packageFixture('mcp'); await write('opencode.jsonc', '// Мой комментарий\n{"model":"личная-модель","mcp":{"personal":{"secret":"не-передавать"}}}\n');
        await install('test-project', pkg, authorize, progress); const receipt = await editMcp(pkg, { command: ['manual-command'], enabled: false, secret: 'private-token' });
        const before = await read(receipt.config.path); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        expect(JSON.stringify(summary)).not.toContain('private-token'); const result = await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        const after = await read(receipt.config.path); expect(after).toContain('// Мой комментарий'); expect(parse(after)).toMatchObject({ model: 'личная-модель', mcp: { personal: { secret: 'не-передавать' }, [receipt.config.key]: receipt.config.value } });
        expect(JSON.parse(await fs.readFile(result.recoveryPath, 'utf8')).changes.find((item: {relative:string}) => item.relative === receipt.config.path).before).toBe(before);
    });
    it('Отсутствующее подключение добавляется только на доказанном пути квитанции', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, authorize, progress); const receipt = await editMcp(pkg, undefined);
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        expect(parse(await read(receipt.config.path)).mcp[receipt.config.key]).toEqual(receipt.config.value);
    });
    it.each(['mcp', 'plugin'])('Восстанавливает %s после переноса со старым root и runtime в квитанции', async kind => {
        const pkg = packageFixture(kind); await install('test-project', pkg, authorize, progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        const expected = receipt.config.value; const oldEntry = path.join(fixture.temporary, 'прежний-проект', assetBase(pkg), pkg.config!.entrypoint!);
        const old = kind === 'mcp' ? { ...expected, command: [path.join(fixture.temporary, 'старый-node'), oldEntry] } : pathToFileURL(oldEntry).href;
        receipt.config.value = old; await write(receiptPath(pkg), JSON.stringify(receipt));
        await write(receipt.config.path, JSON.stringify(kind === 'mcp' ? { mcp: { [receipt.config.key]: old }, model: 'мой' } : { plugin: [old, 'external-plugin'], model: 'мой' }));
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        expect(JSON.parse(await read(receiptPath(pkg))).config.value).toEqual(expected);
        expect(parse(await read(receipt.config.path))).toEqual(kind === 'mcp' ? { mcp: { [receipt.config.key]: expected }, model: 'мой' } : { plugin: ['external-plugin', expected], model: 'мой' });
    });
    it('Дублирующий MCP key в другом config останавливает сравнение', async () => {
        const pkg = packageFixture('mcp'); await install('test-project', pkg, authorize, progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        await write('opencode.jsonc', JSON.stringify({ mcp: { [receipt.config.key]: receipt.config.value } }));
        await expect(prepareLocalChange('test-project', pkg, undefined, authorize)).rejects.toThrow('неоднозначно');
    });
    it('Плагин заменяет только доказанный URL своего bundle и сохраняет внешний spec', async () => {
        const pkg = packageFixture('plugin'); await install('test-project', pkg, authorize, progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        const custom = pathToFileURL(path.join(fixture.root, assetBase(pkg), 'ручная-точка.mjs')).href;
        const external = 'file:///private/external/personal-plugin.mjs'; await write(receipt.config.path, '// Соседний плагин\n' + JSON.stringify({ plugin: [external, custom], model: 'мой' }));
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        expect(parse(await read(receipt.config.path)).plugin).toEqual([external, receipt.config.value]); expect(await read(receipt.config.path)).toContain('// Соседний плагин');
    });
    it('Плагин не присваивает внешний URL с сегментом .. внутри строки bundle', async () => {
        const pkg = packageFixture('plugin'); await install('test-project', pkg, authorize, progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        const external = pathToFileURL(path.join(fixture.root, assetBase(pkg))).href + '/../personal.mjs';
        await write(receipt.config.path, JSON.stringify({ plugin: [external] }));
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); await applyLocalChange('test-project', pkg, options(summary), authorize, progress);
        expect(parse(await read(receipt.config.path)).plugin).toEqual([external, receipt.config.value]);
    });
    it('Повреждённая квитанция и другая версия не дают присвоить ручные файлы', async () => {
        const pkg = await dirtySkill();
        await expect(prepareLocalChange('test-project', packageFixture('skill', 2), undefined, authorize)).rejects.toThrow('другая версия');
        const receipt = JSON.parse(await read(receiptPath(pkg))); receipt.files[assetBase(pkg) + '/SKILL.md'] = 'a'.repeat(64); await write(receiptPath(pkg), JSON.stringify(receipt));
        await expect(prepareLocalChange('test-project', pkg, undefined, authorize)).rejects.toThrow('Квитанция'); expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Отсутствующая квитанция не разрешает восстановление с сервера поверх неизвестного файла', async () => {
        const pkg = await dirtySkill(); await fs.unlink(path.join(fixture.root, receiptPath(pkg))); await fs.unlink(path.join(fixture.root, LEDGER_PATH));
        await expect(prepareLocalChange('test-project', pkg, undefined, authorize)).rejects.toThrow('Нет квитанции'); expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Изменение bytes, receipt или inode после просмотра требует нового сравнения', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        const file = path.join(fixture.root, receiptPath(pkg)); const before = await fs.readFile(file); await fs.rename(file, file + '.ручная-копия'); await fs.writeFile(file, before);
        await expect(applyLocalChange('test-project', pkg, options(summary), authorize, progress)).rejects.toThrow('изменился после сравнения');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Ручная правка во время нового authorize сохраняется и отменяет применение', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        await expect(applyLocalChange('test-project', pkg, options(summary), async () => { await write(assetBase(pkg) + '/SKILL.md', 'ещё одна правка'); }, progress)).rejects.toThrow('изменился после сравнения');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('ещё одна правка');
    });
    it('Отказ нового authorize не меняет файлы', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        await expect(applyLocalChange('test-project', pkg, options(summary), async () => { throw new Error('Разрешение отозвано'); }, progress)).rejects.toThrow('отозвано');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Истечение 15 минут, чужой digest и binding блокируют применение', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        await expect(applyLocalChange('test-project', pkg, { ...options(summary), digest: 'a'.repeat(64) }, authorize, progress)).rejects.toThrow('не соответствует');
        await expect(applyLocalChange('test-project', pkg, { ...options(summary), expectedBindingId: 'a'.repeat(64) }, authorize, progress)).rejects.toThrow('не соответствует');
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(summary.expiresAt) + 1);
        await expect(applyLocalChange('test-project', pkg, options(summary), authorize, progress)).rejects.toThrow('истёк');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Выбор другой папки после сравнения не переносит план на неё', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize);
        const other = path.join(path.dirname(fixture.root), 'другой проект'); await fs.mkdir(other); await bindProject('test-project', path.basename(other));
        await expect(applyLocalChange('test-project', pkg, options(summary), authorize, progress)).rejects.toThrow('Папка проекта изменилась');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Подмена private diff или HTML обнаруживается до применения и открытия', async () => {
        const pkg = await dirtySkill(); const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); const report = await localChangeReportPath(summary.planId);
        await fs.writeFile(report, '<script>подмена</script>'); await expect(localChangeReportPath(summary.planId)).rejects.toThrow('отчёт изменён');
        const plan = JSON.parse(await fs.readFile(stored(summary), 'utf8')); plan.changes[0].after = Buffer.from('подмена').toString('base64'); await fs.writeFile(stored(summary), JSON.stringify(plan));
        await expect(applyLocalChange('test-project', pkg, options(summary), authorize, progress)).rejects.toThrow('повреждён или изменён');
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Мутация входного пакета во время authorize не меняет уже подготовленные bytes', async () => {
        const pkg = await dirtySkill(); const original = structuredClone(pkg);
        const summary = await prepareLocalChange('test-project', pkg, undefined, async () => { pkg.files[0]!.content = 'внешняя мутация'; pkg.manifest.sha256 = 'a'.repeat(64); });
        expect(summary.manifest).toBe(original.manifest.sha256); await applyLocalChange('test-project', original, options(summary), authorize, progress);
        expect(await read(assetBase(original) + '/SKILL.md')).toBe(original.files[0]!.content);
    });
    it('Превышение отдельной квоты планов сохраняет историю и не создаёт diff', async () => {
        const pkg = await dirtySkill(); const directory = path.join(stateDir(), 'local-change-plans'); await fs.mkdir(directory);
        const file = path.join(directory, 'ручной-архив'); await fs.writeFile(file, ''); await fs.truncate(file, 1024 * 1048576);
        await expect(prepareLocalChange('test-project', pkg, undefined, authorize)).rejects.toThrow('1 ГиБ'); expect(await fs.readdir(directory)).toEqual(['ручной-архив']);
        expect(await read(assetBase(pkg) + '/SKILL.md')).toBe('моя ручная правка');
    });
    it('Полный graph восстанавливается одной транзакцией с отдельными root и set SHA', async () => {
        const dep = setPackage('dep'); const root = setPackage('root', 'skill', 1, [dep]); const set = setFixture(root, [dep]);
        await installSet('test-project', set, authorize, progress); await write(assetBase(root) + '/SKILL.md', 'мой root'); await write(assetBase(dep) + '/index.mjs', 'мой dep');
        const summary = await prepareLocalChange('test-project', root, set, authorize); expect(summary.manifest).toBe(root.manifest.sha256);
        const before = await fs.readdir(path.join(journalDirectory(fixture.root), 'history'));
        const result = await applyLocalChange('test-project', root, { ...options(summary), installSet: set }, authorize, progress);
        expect(result.manifest).toBe(set.manifest); expect(result.packages).toHaveLength(2); expect((await fs.readdir(path.join(journalDirectory(fixture.root), 'history'))).length).toBe(before.length + 1);
        expect(await read(assetBase(root) + '/SKILL.md')).toBe(root.files[0]!.content); expect(await read(assetBase(dep) + '/index.mjs')).toBe(dep.files[0]!.content);
    });
    it('Уже синхронизированный инструмент возвращает пустое сравнение', async () => {
        const pkg = packageFixture(); await install('test-project', pkg, authorize, progress);
        const summary = await prepareLocalChange('test-project', pkg, undefined, authorize); expect(summary.files).toEqual([]);
    });
});
