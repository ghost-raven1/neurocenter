import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install, installSet } from '../src/bridge/installer.js';
import { prepareLocalChange, applyLocalChange } from '../src/bridge/local-change-plan.js';
import { listLocalVariants, prepareLocalRestore, applyLocalRestore } from '../src/bridge/local-recovery.js';
import { assetBase, assetKey, receiptPath } from '../src/bridge/installation-receipt.js';
import { LEDGER_PATH } from '../src/bridge/installation-ledger.js';
import { encodeJournal, journalDirectory, type Journal } from '../src/bridge/installation-journal.js';
import { indexLocalRecovery, variantIndexDirectory } from '../src/bridge/local-recovery-index.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { bindProject, projectBindingId, projectInstanceId, prepareProjectBinding, commitProjectBinding } from '../src/bridge/workspace.js';
import { hash, jobContext, stateDir } from '../src/bridge/state.js';
import { recoverFileJobs } from '../src/bridge/installation-files.js';
import { deliverCompletions, pendingCompletions } from '../src/bridge/completions.js';
import { localChangeDigest, localChangeFiles, localChangeHtml } from '../src/bridge/local-change-plan-storage.js';
import type { LocalChangeSummary } from '../src/bridge/local-change-plan.model.js';
import type { InstallSet } from '../src/bridge/install-set.js';
import { packageFixture, workspaceFixture } from './bridge-fixture.js';
import { setFixture, setPackage } from './install-set-fixture.js';

describe('Явное восстановление сохранённых локальных вариантов', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    const authorize = vi.fn(async () => undefined); const progress = vi.fn(async () => undefined);
    const file = (relative: string) => path.join(fixture.root,relative);
    const read = (relative: string) => fs.readFile(file(relative),'utf8');
    const write = (relative: string,bytes: string | Buffer) => fs.writeFile(file(relative),bytes);
    const options = (summary: LocalChangeSummary,set?: InstallSet) => ({planId:summary.planId,revision:1 as const,digest:summary.digest,expectedBindingId:summary.bindingId,...(set ? {installSet:set} : {})});
    beforeEach(async () => { fixture = await workspaceFixture(); authorize.mockClear(); progress.mockClear(); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary,{recursive:true,force:true}); });
    async function backup(pkg = packageFixture(),set?: InstallSet) {
        const preview = await prepareLocalChange('test-project',pkg,set,authorize);
        const result = await applyLocalChange('test-project',pkg,options(preview,set),authorize,progress);
        const journal = JSON.parse(await fs.readFile(result.recoveryPath,'utf8')) as Journal;
        return {pkg,set,preview,result,journal,recoveryId:journal.id};
    }
    async function skillBackup(value: string | Buffer = 'мой локальный вариант') {
        const pkg = packageFixture(); await install('test-project',pkg,authorize,progress);
        await write(assetBase(pkg) + '/SKILL.md',value); return backup(pkg);
    }
    const preview = (saved: Awaited<ReturnType<typeof backup>>,paths?: string[]) => prepareLocalRestore('test-project',saved.pkg,saved.set,{recoveryId:saved.recoveryId,...(paths ? {paths} : {})},authorize);

    it('Список не раскрывает bytes и пути; применение возвращает ручной вариант без изменения approved receipt и ledger', async () => {
        const secret = '<script>мой_секрет</script>'; const saved = await skillBackup(secret);
        const receipt = await read(receiptPath(saved.pkg)); const ledger = await read(LEDGER_PATH);
        const variants = await listLocalVariants('test-project',saved.pkg,undefined,authorize);
        expect(variants.entries.find(item => item.recoveryId === saved.recoveryId)).toMatchObject({eligible:true,reason:'ready',files:1});
        expect(JSON.stringify(variants)).not.toContain(secret); expect(JSON.stringify(variants)).not.toContain(fixture.root);
        const before = await fs.stat(file(assetBase(saved.pkg) + '/SKILL.md')); const plan = await preview(saved);
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe(saved.pkg.files[0]!.content);
        expect((await fs.stat(file(assetBase(saved.pkg) + '/SKILL.md'))).mtimeMs).toBe(before.mtimeMs);
        expect(JSON.stringify(plan)).not.toContain(secret); expect(plan.files[0]!.afterSha256).toBe(hash(secret));
        const result = await applyLocalRestore('test-project',saved.pkg,options(plan),authorize,progress);
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe(secret); expect(await read(receiptPath(saved.pkg))).toBe(receipt); expect(await read(LEDGER_PATH)).toBe(ledger);
        expect((await inspectInstallation('test-project',saved.pkg)).status).toBe('modified');
        const next = JSON.parse(await fs.readFile(result.recoveryPath,'utf8')) as Journal;
        expect(next.recovery?.instanceId).toBe(await projectInstanceId('test-project'));
        expect(Buffer.from(next.changes[0]!.before!,'base64').toString()).toBe(saved.pkg.files[0]!.content);
        expect((await listLocalVariants('test-project',saved.pkg,undefined,authorize)).entries.some(item => item.recoveryId === next.id && item.eligible)).toBe(true);
    });
    it('Бинарные bytes восстанавливаются без потерь', async () => {
        const bytes = Buffer.from([0,255,128,10]); const saved = await skillBackup(bytes); const plan = await preview(saved);
        expect(plan.files[0]!.binary).toBe(true); await applyLocalRestore('test-project',saved.pkg,options(plan),authorize,progress);
        expect(await fs.readFile(file(assetBase(saved.pkg) + '/SKILL.md'))).toEqual(bytes);
    });
    it('Намеренно отсутствовавший файл снова удаляется при восстановлении', async () => {
        const pkg = packageFixture(); await install('test-project',pkg,authorize,progress);
        await fs.unlink(file(assetBase(pkg) + '/SKILL.md')); const absent = await backup(pkg); const missing = await preview(absent);
        expect(missing.files[0]!.operation).toBe('remove'); await applyLocalRestore('test-project',pkg,options(missing),authorize,progress);
        await expect(fs.lstat(file(assetBase(pkg) + '/SKILL.md'))).rejects.toMatchObject({code:'ENOENT'});
    });
    it('MCP возвращает только собственный элемент; новые соседние значения и комментарии сохраняются', async () => {
        const pkg = packageFixture('mcp'); await install('test-project',pkg,authorize,progress);
        const receipt = JSON.parse(await read(receiptPath(pkg))); const relative = receipt.config.path;
        const custom = {type:'local',enabled:false,command:['manual'],environment:{TOKEN:'ЛОКАЛЬНЫЙ_TOKEN'}};
        await write(relative,applyEdits(await read(relative),modify(await read(relative),['mcp',receipt.config.key],custom,{})));
        const saved = await backup(pkg); const source = await read(relative);
        await write(relative,'// НОВЫЙ КОММЕНТАРИЙ\n' + applyEdits(source,modify(source,['personal'],{secret:'новый-сосед'},{})));
        const receiptBefore = await read(receiptPath(pkg)); const plan = await preview(saved);
        await applyLocalRestore('test-project',pkg,options(plan),authorize,progress);
        expect(parse(await read(relative))).toMatchObject({mcp:{[receipt.config.key]:custom},personal:{secret:'новый-сосед'}});
        expect(await read(relative)).toContain('// НОВЫЙ КОММЕНТАРИЙ'); expect(await read(receiptPath(pkg))).toBe(receiptBefore);
    });
    it('Plugin меняет единственный свой URL, сохраняя комментарии и внешние элементы массива', async () => {
        const pkg = packageFixture('plugin'); await install('test-project',pkg,authorize,progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        const custom = pathToFileURL(file(assetBase(pkg) + '/ручной.mjs')).href;
        await write(receipt.config.path,JSON.stringify({plugin:[custom,'npm:чужой']})); const saved = await backup(pkg);
        await write(receipt.config.path,'{ "plugin": [ // ПЛАГИН СОСЕДА\n "npm:новый-сосед", ' + JSON.stringify(receipt.config.value) + '],"other":1}');
        await applyLocalRestore('test-project',pkg,options(await preview(saved)),authorize,progress);
        expect(parse(await read(receipt.config.path))).toEqual({plugin:['npm:новый-сосед',custom],other:1});
        expect(await read(receipt.config.path)).toContain('// ПЛАГИН СОСЕДА');
    });
    it('Пропавшее собственное MCP подключение удаляется без удаления JSONC с соседями', async () => {
        const pkg = packageFixture('mcp'); await install('test-project',pkg,authorize,progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        await fs.unlink(file(receipt.config.path)); const saved = await backup(pkg);
        await write(receipt.config.path,'// Сохраняем файл\n' + JSON.stringify({mcp:{[receipt.config.key]:receipt.config.value},model:'мой'}));
        await applyLocalRestore('test-project',pkg,options(await preview(saved)),authorize,progress);
        expect(parse(await read(receipt.config.path))).toEqual({mcp:{},model:'мой'}); expect(await read(receipt.config.path)).toContain('// Сохраняем файл');
    });
    it('Shared dependency блокирует весь default preview; явный выбор root-файла не меняет зависимость', async () => {
        const dep = setPackage('shared'); const root = setPackage('root','skill',1,[dep]); const set = setFixture(root,[dep]);
        await installSet('test-project',set,authorize,progress);
        const other = setPackage('other','skill',1,[dep]); await installSet('test-project',setFixture(other,[dep]),authorize,progress);
        await write(assetBase(root) + '/SKILL.md','локальный root'); await write(assetBase(dep) + '/index.mjs','локальная зависимость'); const saved = await backup(root,set);
        expect((await listLocalVariants('test-project',root,set,authorize)).entries.find(item => item.recoveryId === saved.recoveryId)?.reason).toBe('shared-dependency');
        await expect(preview(saved)).rejects.toMatchObject({reason:'shared-dependency'});
        const plan = await preview(saved,[assetBase(root) + '/SKILL.md']); await applyLocalRestore('test-project',root,options(plan,set),authorize,progress);
        expect(await read(assetBase(root) + '/SKILL.md')).toBe('локальный root'); expect(await read(assetBase(dep) + '/index.mjs')).toBe(dep.files[0]!.content);
    });
    it('Новый владелец зависимости после preview отменяет применение', async () => {
        const dep = setPackage('shared'); const root = setPackage('root','skill',1,[dep]); const set = setFixture(root,[dep]); await installSet('test-project',set,authorize,progress);
        await write(assetBase(dep) + '/index.mjs','ручной dep'); const saved = await backup(root,set); const plan = await preview(saved);
        const other = setPackage('other','skill',1,[dep]); await installSet('test-project',setFixture(other,[dep]),authorize,progress);
        await expect(applyLocalRestore('test-project',root,options(plan,set),authorize,progress)).rejects.toMatchObject({reason:'shared-dependency'});
        expect(await read(assetBase(dep) + '/index.mjs')).toBe(dep.files[0]!.content);
    });
    it('Установленная leaf-зависимость без отдельного root получает честный пустой список', async () => {
        const dep = setPackage('leaf'); const root = setPackage('root','skill',1,[dep]); await installSet('test-project',setFixture(root,[dep]),authorize,progress);
        const list = await listLocalVariants('test-project',dep,undefined,authorize); expect(list.entries).toEqual([]); expect(list.complete).toBe(true);
    });
    it('Правка после preview и отказ нового authorize сохраняют текущие bytes', async () => {
        const saved = await skillBackup(); const plan = await preview(saved);
        await expect(applyLocalRestore('test-project',saved.pkg,options(plan),async () => { throw new Error('Доступ отозван'); },progress)).rejects.toThrow('отозван');
        await expect(applyLocalRestore('test-project',saved.pkg,options(plan),async () => { await write(assetBase(saved.pkg) + '/SKILL.md','поздняя правка'); },progress)).rejects.toThrow();
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe('поздняя правка');
    });
    it('Digest, binding, срок, другая версия и repair-purpose не подменяют restore', async () => {
        const saved = await skillBackup(); const plan = await preview(saved);
        await expect(applyLocalRestore('test-project',saved.pkg,{...options(plan),digest:'a'.repeat(64)},authorize,progress)).rejects.toThrow();
        await expect(applyLocalRestore('test-project',saved.pkg,{...options(plan),expectedBindingId:'a'.repeat(64)},authorize,progress)).rejects.toThrow();
        await expect(applyLocalRestore('test-project',packageFixture('skill',2),options(plan),authorize,progress)).rejects.toThrow();
        await expect(applyLocalChange('test-project',saved.pkg,options(plan),authorize,progress)).rejects.toThrow();
        await expect(applyLocalRestore('test-project',saved.pkg,options(saved.preview),authorize,progress)).rejects.toThrow();
        vi.spyOn(Date,'now').mockReturnValue(Date.parse(plan.expiresAt)+1);
        await expect(applyLocalRestore('test-project',saved.pkg,options(plan),authorize,progress)).rejects.toThrow('истёк');
    });
    it('Rename сохраняет доступ к копии по instance, а новая физическая папка её не наследует', async () => {
        const saved = await skillBackup(); const bindingId = await projectBindingId('test-project'); const instanceId = await projectInstanceId('test-project');
        const moved = path.join(path.dirname(fixture.root),'после rename'); await fs.rename(fixture.root,moved); fixture.root = moved;
        await commitProjectBinding(await prepareProjectBinding({projectId:'test-project',folderName:path.basename(moved),mode:'transfer',expectedBindingId:bindingId,expectedInstanceId:instanceId}),async () => undefined);
        await applyLocalRestore('test-project',saved.pkg,options(await preview(saved)),authorize,progress);
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe('мой локальный вариант');
        const other = path.join(path.dirname(fixture.root),'другой экземпляр'); await fs.mkdir(other); await bindProject('test-project',path.basename(other));
        await install('test-project',saved.pkg,authorize,progress);
        expect((await listLocalVariants('test-project',saved.pkg,undefined,authorize)).entries.some(item => item.recoveryId === saved.recoveryId)).toBe(false);
        await expect(preview(saved)).rejects.toThrow();
    });
    it('Журнал 0.7 доступен только при точном совпадении private plan; неподтверждённый v1 остаётся view-only', async () => {
        const saved = await skillBackup(); delete saved.journal.recovery; await fs.writeFile(saved.result.recoveryPath,JSON.stringify(saved.journal));
        await fs.rm(variantIndexDirectory(await projectInstanceId('test-project')),{recursive:true});
        expect((await listLocalVariants('test-project',saved.pkg,undefined,authorize)).entries.find(item => item.recoveryId === saved.recoveryId)?.eligible).toBe(true);
        saved.journal.changes[0]!.before = Buffer.from('подменённый архив').toString('base64'); await fs.writeFile(saved.result.recoveryPath,JSON.stringify(saved.journal));
        const variants = await listLocalVariants('test-project',saved.pkg,undefined,authorize);
        expect(variants.entries.find(item => item.recoveryId === saved.recoveryId)).toMatchObject({eligible:false,reason:'legacy-unverified'});
        await expect(preview(saved)).rejects.toThrow();
    });
    it('Подмена копии после preview и выбор marker или receipt не дают произвольной записи', async () => {
        const saved = await skillBackup(); const plan = await preview(saved);
        await expect(preview(saved,['.opencode/neurocenter.json'])).rejects.toThrow(); await expect(preview(saved,[receiptPath(saved.pkg)])).rejects.toThrow();
        saved.journal.changes[0]!.before = Buffer.from('подмена').toString('base64'); await fs.writeFile(saved.result.recoveryPath,JSON.stringify(saved.journal));
        await expect(applyLocalRestore('test-project',saved.pkg,options(plan),authorize,progress)).rejects.toThrow();
        saved.journal.changes.push({relative:'.opencode/neurocenter.json',before:'{}',after:'{}'}); await fs.writeFile(saved.result.recoveryPath,JSON.stringify(saved.journal));
        expect((await listLocalVariants('test-project',saved.pkg,undefined,authorize)).entries.find(item => item.recoveryId === saved.recoveryId)?.reason).toBe('invalid-backup');
    });
    it('Самосогласованная подмена private restore-plan не подменяет байты выбранной резервной копии', async () => {
        const saved = await skillBackup(); const summary = await preview(saved); const target = path.join(stateDir(),'local-change-plans',summary.planId + '.json');
        const plan = JSON.parse(await fs.readFile(target,'utf8')); plan.changes[0].after = Buffer.from('не из резервной копии').toString('base64');
        plan.summary.files = localChangeFiles(plan.changes); plan.reportSha256 = hash(localChangeHtml(plan)); plan.summary.digest = localChangeDigest(plan);
        await fs.writeFile(target,JSON.stringify(plan));
        await expect(applyLocalRestore('test-project',saved.pkg,options(plan.summary),authorize,progress)).rejects.toMatchObject({reason:'invalid-backup'});
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe(saved.pkg.files[0]!.content);
    });
    it('Неподтверждённая конфигурация receipt и чужое владение файлом останавливают восстановление', async () => {
        const pkg = packageFixture('mcp'); await install('test-project',pkg,authorize,progress); const saved = await backup(pkg);
        const original = await read(receiptPath(pkg)); const receipt = JSON.parse(original); receipt.config.value.environment = {PRIVATE:'подмена'};
        await write(receiptPath(pkg),JSON.stringify(receipt)); await expect(preview(saved)).rejects.toMatchObject({reason:'different-installation'});
        await write(receiptPath(pkg),original); const other = setPackage('other','skill'); await install('test-project',other,authorize,progress);
        const foreign = JSON.parse(await read(receiptPath(other))); foreign.files[assetBase(pkg) + '/index.mjs'] = pkg.files[0]!.sha256;
        await write(receiptPath(other),JSON.stringify(foreign)); await expect(preview(saved)).rejects.toMatchObject({reason:'different-installation'});
    });
    it('Дубликаты JSONC ключей не разрешают неоднозначное восстановление', async () => {
        const pkg = packageFixture('mcp'); await install('test-project',pkg,authorize,progress); const receipt = JSON.parse(await read(receiptPath(pkg)));
        const saved = await backup(pkg); saved.journal.changes.push({relative:receipt.config.path,before:'{"mcp":{},"mcp":{}}',after:await read(receipt.config.path)});
        await fs.writeFile(saved.result.recoveryPath,JSON.stringify(saved.journal)); await expect(preview(saved)).rejects.toMatchObject({reason:'invalid-backup'});
    });
    it('Список ограничен сотней и не объявляет усечённую историю полной', async () => {
        const saved = await skillBackup();
        for (let index=0;index<101;index++) {
            const journal = structuredClone(saved.journal); journal.id = randomUUID(); journal.recovery!.createdAt = new Date(Date.now()+index).toISOString();
            await fs.writeFile(path.join(journalDirectory(fixture.root),'history',journal.id + '.json'),encodeJournal(journal)); await indexLocalRecovery(journal);
        }
        const list = await listLocalVariants('test-project',saved.pkg,undefined,authorize); expect(list.entries).toHaveLength(100); expect(list.complete).toBe(false);
    },15000);
    it('FIFO и симлинк в истории не читаются и не меняют проект', async () => {
        const saved = await skillBackup(); const target = path.join(journalDirectory(fixture.root),'history',saved.recoveryId + '.json'); await fs.unlink(target);
        if (process.platform !== 'win32') {
            execFileSync('mkfifo',[target]); const list = await listLocalVariants('test-project',saved.pkg,undefined,authorize); expect(list.complete).toBe(false); await fs.unlink(target);
        }
        const secret = path.join(fixture.temporary,'чужой секрет'); await fs.writeFile(secret,'секрет'); await fs.symlink(secret,target);
        const list = await listLocalVariants('test-project',saved.pkg,undefined,authorize); expect(list.complete).toBe(false); expect(await fs.readFile(secret,'utf8')).toBe('секрет');
        expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe(saved.pkg.files[0]!.content);
    });
    it('Прерванное архивирование восстанавливает durable completion без повторной записи файлов', async () => {
        const saved = await skillBackup(); const plan = await preview(saved); const id = randomUUID(); const lease = randomUUID();
        const realLink = fs.link.bind(fs); let once = true;
        vi.spyOn(fs,'link').mockImplementation(async (source,destination) => {
            if (once && String(destination).includes(path.sep + 'history' + path.sep)) { once = false; throw new Error('Потеря подтверждения архива'); }
            return realLink(source,destination);
        });
        await expect(jobContext.run({id,lease},() => applyLocalRestore('test-project',saved.pkg,options(plan),authorize,progress))).rejects.toMatchObject({localChangesCommitted:true});
        const before = await fs.stat(file(assetBase(saved.pkg) + '/SKILL.md')); await recoverFileJobs();
        expect((await pendingCompletions()).find(item => item.id === id)?.result).toMatchObject({changePlanId:plan.planId,digest:plan.digest});
        await expect(deliverCompletions(async () => { throw new Error('Потерян ACK'); })).rejects.toThrow('ACK');
        await deliverCompletions(async () => ({})); expect(await pendingCompletions()).toEqual([]);
        expect((await fs.stat(file(assetBase(saved.pkg) + '/SKILL.md'))).mtimeMs).toBe(before.mtimeMs); expect(await read(assetBase(saved.pkg) + '/SKILL.md')).toBe('мой локальный вариант');
    });
});
