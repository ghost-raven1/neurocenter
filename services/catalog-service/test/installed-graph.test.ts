import { describe, expect, it, vi } from 'vitest';
import { buildPackage, type IPackage } from '../src/catalog/bundle-package';
import { installedGraph } from '../src/devices/installed-graph';
import { installationRef, verifyInstallationSet } from '../src/devices/installation-set';
import { DeviceInstallations } from '../src/devices/device-installations';
import type { DeviceStore } from '../src/devices/device-store';

const remote=(id:string,deps:IPackage[]=[],version=1)=>buildPackage({id:'ai-plug-'+id,kind:'mcp',name:id,version},[],'now',
    {transport:'remote',url:'https://example.test/mcp',extra:{requirements:{mcp:[],plugins:[],dependencies:deps.map(installationRef)}}});
describe('Замороженный граф после переноса экземпляра',()=>{
    it('Восстанавливает ромб зависимостей без каталога и одобрения',()=>{
        const shared=remote('shared'),left=remote('left',[shared]),right=remote('right',[shared]),root=remote('root',[left,right]);
        const set=installedGraph(root,[root,left,right,shared,remote('unrelated')]);
        expect(verifyInstallationSet(set)).toBe(true);expect(set.packages).toHaveLength(4);
    });
    it.each(['missing','version','duplicate'])('Не подменяет неполный граф: %s',mode=>{
        const dependency=remote('dependency'),root=remote('root',[dependency]);
        const members=mode==='missing'?[]:mode==='version'?[remote('dependency',[],2)]:[dependency,dependency];
        expect(()=>installedGraph(root,[root,...members])).toThrow();
    });
    it('Список копий корневого инструмента работает для события переноса без installSet в payload',async()=>{
        const dependency=remote('dependency'),root=remote('root',[dependency]),bindingId='b'.repeat(64);
        const query=vi.fn(async(sql:string)=>({rows:sql.includes('SELECT payload FROM latest')?[{payload:{installations:[root,dependency]}}]
            :sql.includes('installed_package AS package')?[{package:dependency}]
            :[{kind:'install',payload:{package:root,bindingId}}]}));
        const installations=new DeviceInstallations({pool:{query}} as unknown as DeviceStore);
        const result=await installations.inspectionDelivery({email:'owner@example.test',activeRole:'Главный админ'},
            {deviceId:'device',projectId:'project',assetId:root.plugin.id,assetKind:'mcp',expectedManifest:root.manifest.sha256,bindingId});
        expect(result.installSet?.packages).toHaveLength(2);expect(verifyInstallationSet(result.installSet!)).toBe(true);
        const pinned=query.mock.calls.find(([sql])=>sql.includes('installed_package AS package'))?.[0];
        expect(pinned).toContain("installed_package->'plugin'->>'version'=$7");
        expect(pinned).toContain("installed_package->'manifest'->>'sha256'=$8");
    });
});
