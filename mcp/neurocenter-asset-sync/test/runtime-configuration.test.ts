import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceFixture } from './bridge-fixture.js';
import { rehashPackage, setFixture } from './install-set-fixture.js';
import { fakeEngine, mcpSource, probeInput, probePackage, noop } from './runtime-probe-fixture.js';
import { writeState } from '../src/bridge/state.js';
import { runRuntimeProbe } from '../src/features/runtime-probe/index.js';
import { configurationContext } from '../src/features/local-configuration/context.js';
import { saveConfiguration } from '../src/features/local-configuration/state.js';
import { getMcpConfigurationStatus } from '../src/features/local-configuration/index.js';
import { packageRef } from '../src/bridge/install-set.js';
import { installSet } from '../src/bridge/installer.js';

describe('Диагностика с локальными параметрами MCP',()=>{
    let temporary='';
    beforeEach(async()=>{({temporary}=await workspaceFixture());await writeState('credentials',{deviceId:'runtime-config-device',token:'закрыто',email:'test@example.org'});});
    afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(temporary,{recursive:true,force:true});});
    async function fixture(){
        const log=path.join(temporary,'methods.log');const pkg=probePackage('mcp',mcpSource(log,"if(process.env.PRIVATE_TEST_KEY!=='ЛОКАЛЬНЫЙ_КЛЮЧ')process.exit(23);"));
        pkg.schemaVersion=5;pkg.config={...pkg.config,extra:{localConfiguration:{schemaVersion:1,fields:[{id:'key',label:'Ключ',type:'string',secret:true,required:true,target:{kind:'env',name:'PRIVATE_TEST_KEY'}}]}}};rehashPackage(pkg);
        const input=await probeInput(pkg,await fakeEngine(temporary));const context=await configurationContext('test-project',pkg,undefined,noop);
        return {pkg,input,context,log};
    }
    it('не запускает MCP до заполнения обязательного поля',async()=>{
        const {input,log}=await fixture();const result=await runRuntimeProbe(input);
        expect(result).toMatchObject({status:'needs_configuration',code:'configuration-required'});await expect(fs.lstat(log)).rejects.toThrow();
    });
    it('передаёт секрет только соответствующему дочернему MCP и фиксирует ревизию',async()=>{
        const {pkg,input,context,log}=await fixture();await saveConfiguration(context,{key:'ЛОКАЛЬНЫЙ_КЛЮЧ'},null,noop);
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);input.configurationRevisions=[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision}];
        const result=await runRuntimeProbe(input);expect(result).toMatchObject({status:'passed',code:'verified',configurationRevisions:input.configurationRevisions});
        expect(JSON.stringify(result)).not.toContain('ЛОКАЛЬНЫЙ_КЛЮЧ');expect(process.env.PRIVATE_TEST_KEY).toBeUndefined();
        expect(await fs.readFile(log,'utf8')).toContain('initialize');
    });
    it('несогласованная или изменённая ревизия делает проверку устаревшей до запуска',async()=>{
        const {pkg,input,context,log}=await fixture();await saveConfiguration(context,{key:'ЛОКАЛЬНЫЙ_КЛЮЧ'},null,noop);
        const missing=await runRuntimeProbe(input);expect(missing).toMatchObject({status:'stale',code:'configuration-changed'});
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);input.configurationRevisions=[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision}];
        await saveConfiguration(context,{key:'НОВЫЙ_КЛЮЧ'},status.revision,noop);
        const changed=await runRuntimeProbe(input);expect(changed).toMatchObject({status:'stale',code:'configuration-changed',configurationRevisions:input.configurationRevisions});await expect(fs.lstat(log)).rejects.toThrow();
    });
    it('повторная авторизация замечает изменение параметров перед запуском процесса',async()=>{
        const {pkg,input,context,log}=await fixture();await saveConfiguration(context,{key:'ЛОКАЛЬНЫЙ_КЛЮЧ'},null,noop);
        const status=await getMcpConfigurationStatus('test-project',pkg,undefined,noop);input.configurationRevisions=[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision}];
        input.authorize=async()=>{await saveConfiguration(context,{key:'НОВЫЙ_КЛЮЧ'},status.revision,noop);};
        expect(await runRuntimeProbe(input)).toMatchObject({status:'stale',code:'configuration-changed',configurationRevisions:input.configurationRevisions});await expect(fs.lstat(log)).rejects.toThrow();
    });
    it('дополнительные поля в ревизии отклоняются и не копируются в публичный отчёт',async()=>{
        const {pkg,input}=await fixture();input.configurationRevisions=[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:null,secret:'НЕ_ВЫВОДИТЬ'}] as never;
        const result=await runRuntimeProbe(input);expect(result.code).toBe('invalid-package');expect(JSON.stringify(result)).not.toContain('НЕ_ВЫВОДИТЬ');
    });
    it('одинаковый ID скилла и настроенного MCP не заменяет исходный вид и счётчики полного графа',async()=>{
        const {pkg,input,context}=await fixture();await saveConfiguration(context,{key:'ЛОКАЛЬНЫЙ_КЛЮЧ'},null,noop);
        const parent=probePackage('skill');parent.plugin.id=pkg.plugin.id;
        parent.config={extra:{requirements:{dependencies:[packageRef(pkg)]}}};rehashPackage(parent);
        const set=setFixture(parent,[pkg]);await installSet('test-project',set,noop,noop);
        const status=await getMcpConfigurationStatus('test-project',pkg,set,noop);
        const result=await runRuntimeProbe({...input,target:packageRef(parent),frozenSet:set,consentManifest:set.manifest,
            configurationRevisions:[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision}]});
        expect(result).toMatchObject({status:'passed',assetKind:'skill',counts:{packages:2,files:2,skills:1,mcp:1,pluginsInitialized:0}});
    });
    it('плагин с тем же ID настроенного MCP действительно проверяется и не получает ложный passed',async()=>{
        const {pkg,input,context}=await fixture();await saveConfiguration(context,{key:'ЛОКАЛЬНЫЙ_КЛЮЧ'},null,noop);
        const parent=probePackage('plugin','export default async()=>{throw new Error("Оригинальный плагин не готов");};');parent.plugin.id=pkg.plugin.id;
        parent.config={...parent.config,extra:{requirements:{dependencies:[packageRef(pkg)]}}};rehashPackage(parent);
        const set=setFixture(parent,[pkg]);await installSet('test-project',set,noop,noop);
        const status=await getMcpConfigurationStatus('test-project',pkg,set,noop);
        const result=await runRuntimeProbe({...input,target:packageRef(parent),frozenSet:set,consentManifest:set.manifest,
            configurationRevisions:[{assetId:pkg.plugin.id,manifest:pkg.manifest.sha256,revision:status.revision}]});
        expect(result).toMatchObject({status:'failed',code:'plugin-initialization-failed',assetKind:'plugin',counts:{packages:1,mcp:1,skills:0,pluginsInitialized:0}});
    });
});
