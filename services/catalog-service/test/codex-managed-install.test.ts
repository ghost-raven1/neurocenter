import {describe,expect,it,vi} from 'vitest';
import {createRequire} from 'node:module';
import {artifactFixture} from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {buildPackage,type IPackage} from '../src/catalog/bundle-package';
import {InstallPlans} from '../src/devices/install-plans';
import type {InstallPlanRow} from '../src/devices/install-plan.model';
import {installationRef,installationSetHash} from '../src/devices/installation-set';
import {isManagedCodexConnectorPackage} from '../../shared/codex-connector-source.cjs';

const pin=createRequire(import.meta.url)('../../shared/codex-connector-pin.json');
const actor={email:'admin@example.test',activeRole:'Главный админ'},project='prj-codex-install',id='12345678-1234-4234-8234-123456789abc';
function connector():IPackage{
    const {descriptor}=artifactFixture([{path:'codex-plugin.mjs',content:'export default async()=>({});'}]);
    return buildPackage({kind:'plugin',id:'ai-plug-codex',name:'codex',version:1},[],'fixture',
        {extra:{runtimeArtifacts:[descriptor],codexConnector:{schemaVersion:1,authOnly:true,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion}}});
}
const ordinary=()=>buildPackage({kind:'plugin',id:'ai-plug-ordinary',name:'ordinary',version:1},[{path:'index.mjs',content:'export default async()=>({event:async()=>{}});'}],'fixture',{entrypoint:'index.mjs'});

/** Storage is a controlled port; the real admission/resolver validates package bytes and graph before any write. */
function fixture(pkg:IPackage,dependencies:IPackage[]=[]){
    const packages=[pkg,...dependencies],set=dependencies.length?{schemaVersion:1 as const,root:installationRef(pkg),packages,manifest:installationSetHash(installationRef(pkg),packages)}:undefined;
    let row:InstallPlanRow={id,project_id:project,asset_kind:pkg.plugin.kind,asset_id:pkg.plugin.id,version:1,manifest:set?.manifest??pkg.manifest.sha256,package:pkg,status:'approved',revision:1,approved_by:actor.email,installation_set:set};
    const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
        if(sql.includes('FROM device_install_plans'))return{rows:[row],rowCount:1};
        if(sql.includes('FROM projects'))return{rows:[{id:project}],rowCount:1};
        if(sql.includes('FROM project_assets')){
            const selected=packages.find(value=>value.plugin.id===values[2]);
            return{rows:selected?[{project_id:project,asset_id:selected.plugin.id,asset_kind:selected.plugin.kind,asset_version:1,asset_manifest:selected.manifest.sha256,pin_snapshot:{package:selected}}]:[],rowCount:selected?1:0};
        }
        if(sql.startsWith('INSERT INTO device_install_plans')){row={...row,id:String(values[0]),status:'pending',revision:0};return{rows:[row],rowCount:1};}
        if(sql.startsWith('UPDATE device_install_plans')){row={...row,status:values[1] as InstallPlanRow['status'],revision:row.revision+1};return{rows:[row],rowCount:1};}
        if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('INSERT INTO security_events'))return{rows:[],rowCount:0};
        throw Error('Unexpected controlled storage operation');
    });
    const connect=vi.fn(async()=>({query,release:vi.fn()})),build=vi.fn(async(_kind:string,assetId:string)=>packages.find(value=>value.plugin.id===assetId));
    const service=new InstallPlans({pool:{query,connect},access:{claims:async()=>({email:actor.email,userRoles:[actor.activeRole],projects:[]})}} as never,{build} as never);
    return{service,query,connect,row:()=>row,pending:()=>{row.status='pending';}};
}

describe('Managed Codex supply stays outside generic install admission',()=>{
    it.each(['root','dependency'])('refuses fresh %s before saving an install plan',async position=>{
        const supply=connector(),pkg=position==='root'?supply:buildPackage({kind:'skill',id:'common/helper',name:'helper',version:1},[{path:'SKILL.md',content:'Fixture'}],'fixture',{extra:{requirements:{dependencies:[installationRef(supply)]}}});
        const f=fixture(pkg,position==='root'?[]:[supply]);
        await expect(f.service.prepare(actor,{projectId:project,assetKind:pkg.plugin.kind,assetId:pkg.plugin.id,version:1})).rejects.toThrow('Настроить в OpenCode');
        expect(f.connect).not.toHaveBeenCalled();expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
    });
    it('refuses delivery and approval of an old direct plan while preserving its history and revocation',async()=>{
        const f=fixture(connector()),before=structuredClone(f.row());
        await expect(f.service.delivery(id,project,'plugin',before.asset_id,1,1,before.manifest)).rejects.toThrow('Настроить в OpenCode');
        await expect(f.service.decide(actor,id,{expectedManifest:before.manifest,expectedRevision:1},'approved')).rejects.toThrow('Настроить в OpenCode');
        expect(f.row()).toEqual(before);expect((await f.service.view(actor,id)).manifest).toBe(before.manifest);
        expect((await f.service.approvedInstalled(project,before.package)).package).toEqual(before.package);
        expect((await f.service.decide(actor,id,{expectedManifest:before.manifest,expectedRevision:1},'revoked')).status).toBe('revoked');
    });
    it('keeps ordinary plugin preparation and delivery working',async()=>{
        const pkg=ordinary(),f=fixture(pkg),before=f.row();
        expect((await f.service.delivery(id,project,'plugin',pkg.plugin.id,1,1,before.manifest)).package).toEqual(pkg);
        expect((await f.service.prepare(actor,{projectId:project,assetKind:'plugin',assetId:pkg.plugin.id,version:1})).status).toBe('pending');
        expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO device_install_plans'))).toBe(true);
    });
    it.each(['sourceCommit','version','sdkVersion','extra','entrypoint','kind'])('does not classify a different %s as the pinned managed connector',field=>{
        const pkg=connector(),meta=pkg.config!.extra!.codexConnector as Record<string,unknown>;
        if(field==='entrypoint')(pkg.config!.extra!.runtimeArtifacts as Array<{entrypoint:string}>)[0]!.entrypoint='ordinary.mjs';
        else if(field==='kind')pkg.plugin.kind='mcp';
        else meta[field]=field==='extra'?true:'different';
        expect(isManagedCodexConnectorPackage(pkg)).toBe(false);
        expect(isManagedCodexConnectorPackage(connector())).toBe(true);
    });
});
