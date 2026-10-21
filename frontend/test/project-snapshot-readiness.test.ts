import {describe,expect,it} from 'vitest';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import {snapshotCaptureTarget} from '../src/features/ProjectSnapshots/snapshotReadiness';
const device=():IBridgeDevice=>({id:crypto.randomUUID(),name:'Computer',role:'Разработчик',fingerprint:'x',online:true,lastSeen:new Date().toISOString(),report:{protocolVersion:2,capabilities:['durable-completions','managed-installations','workspace-instance-v1','project-snapshots-v1'],bindings:[{projectId:'project-one',folderName:'folder',valid:true,identityStatus:'verified',bindingId:'a'.repeat(64),instanceId:crypto.randomUUID()}]}});
describe('Full snapshot capture exact computer readiness',()=>{
    it('Only the selected current project binding authorizes capture',()=>{const current=device();expect(snapshotCaptureTarget('project-one',current,true)).toEqual({reason:'',bindingId:'a'.repeat(64),folderName:'folder'});expect(snapshotCaptureTarget('other',current,true).reason).toContain('свяжите');});
    it.each(['stale','offline','reconnect','role','capability','invalid','unverified','instance','ambiguous','root'] as const)('Blocks %s before a publication can be built',kind=>{
        const current=device();if(kind==='offline')current.online=false;if(kind==='reconnect')current.requiresReconnect=true;if(kind==='role')current.role='Наблюдатель';if(kind==='capability')current.report.capabilities=current.report.capabilities!.filter(item=>item!=='project-snapshots-v1');if(kind==='invalid')current.report.bindings![0].valid=false;if(kind==='unverified')current.report.bindings![0].identityStatus='legacy';if(kind==='instance')current.report.bindings![0].instanceId='bad';if(kind==='ambiguous')current.report.bindings!.push({...current.report.bindings![0]});if(kind==='root')current.report.rootError='Folder unavailable';
        expect(snapshotCaptureTarget('project-one',current,kind!=='stale').reason).not.toBe('');
    });
});
