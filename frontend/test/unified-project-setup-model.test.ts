import {describe,expect,it} from 'vitest';
import {setupBinding,setupProjectAssets,unifiedSetupStep} from '../src/modules/Start/projectSetupModel';
import {startQueryUrl,legacyStartRequested} from '../src/modules/Start/startQuery';
import {workspaceInstallerCommand,bridgeInstallerCommand} from '../src/features/McpBridge/connectionCommands';
import type {useBridge} from '../src/features/McpBridge/useBridge';
import type {IProjectAsset,ISkillFile} from '../src/core/api/interfaces';

const hash='a'.repeat(64),instance='00000000-0000-4000-8000-000000000001';
const verified={projectId:'prj-qa',valid:true,identityStatus:'verified',bindingId:hash,instanceId:instance,folderName:'Проект 日本'};
function bridge(changed:Record<string,unknown>={}){
    const device={id:'device-qa',online:true,report:{bindings:[verified]}};
    return {device,devices:[device],devicesReady:true,errors:{devices:''},...changed} as unknown as ReturnType<typeof useBridge>;
}

describe('Unified project setup never turns navigation or a stale assignment into readiness',()=>{
    it('makes the unified experience primary and keeps explicit legacy recovery links',()=>{
        for(const query of ['', '?step=0','?p=prj-qa','?setup=1&step=2','?setup=1&addComputer=1'])expect(legacyStartRequested(query)).toBe(false);
        for(const query of ['?legacy=1','?step=1','?step=2&p=prj-qa','?addComputer=1'])expect(legacyStartRequested(query)).toBe(true);
    });
    it('keeps the selected project and unknown query context on resume',()=>{
        const url=startQueryUrl('?p=prj-qa&extension=rag',{setup:true,step:3},'#details');
        expect(url).toBe('/start?p=prj-qa&extension=rag&step=3&setup=1#details');
        expect(unifiedSetupStep('?step=3')).toBe(3);
        for(const query of ['?step=-1','?step=4','?step=NaN'])expect(unifiedSetupStep(query)).toBe(0);
    });
    it('requires fresh exact identity, one folder and a current owned computer',()=>{
        expect(setupBinding(bridge(),'prj-qa')?.folderName).toBe('Проект 日本');
        for(const changed of [{devicesReady:false},{errors:{devices:'503'}},{devices:[]},{device:undefined},
            {device:{id:'device-qa',online:false,report:{bindings:[verified]}}},
            {device:{id:'device-qa',online:true,report:{bindings:[verified,verified]}}},
            {device:{id:'device-qa',online:true,report:{bindings:[{...verified,identityStatus:'unknown'}]}}},
            {device:{id:'device-qa',online:true,report:{bindings:[{...verified,instanceId:'wrong'}]}}}])expect(setupBinding(bridge(changed),'prj-qa')).toBeUndefined();
        expect(setupBinding(bridge(),'prj-other')).toBeUndefined();
    });
    it('retains missing or stale pins as blocked rows without a global fallback',()=>{
        const refs:IProjectAsset[]=[{assetId:'missing',assetKind:'skill',addedBy:'qa',addedAt:'now'},
            {assetId:'changed',assetKind:'plugin',addedBy:'qa',addedAt:'now',version:2,manifest:hash,pinError:'Pin changed'}];
        const apps=setupProjectAssets(refs);
        expect(apps.map(item=>item.id)).toEqual(['missing','changed']);
        expect(apps.every(item=>!!item.pinError)).toBe(true);
        expect(apps[1].pinError).toBe('Pin changed');
        expect(setupProjectAssets([])).toEqual([]);
        const card={path:'common/helper',meta:{name:'Helper',slug:'helper',version:1,tags:[]},body:'Pinned body'} as ISkillFile;
        const ref:IProjectAsset={assetId:card.path,assetKind:'skill',version:1,manifest:hash,card,addedBy:'qa',addedAt:'now'};
        expect(setupProjectAssets([ref])[0]).toMatchObject({version:1,projectManifest:hash,projectCard:{kind:'skill',skill:card}});
        expect(setupProjectAssets([{...ref,version:2}])[0].pinError).toBeTruthy();
    });
    it('uses one validated Gateway for the new bootstrap and keeps the bridge-only recovery command',()=>{
        expect(workspaceInstallerCommand('https://gateway.example.test/path',false)).toContain("https://gateway.example.test/api/bridge/install_workspace.sh");
        expect(workspaceInstallerCommand('https://gateway.example.test',true)).toContain('/api/bridge/install_workspace.ps1');
        expect(bridgeInstallerCommand('https://gateway.example.test',false)).toContain('/api/bridge/install.sh');
        expect(()=>workspaceInstallerCommand('file:///tmp/qa',false)).toThrow();
    });
});
