import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openCodeIdentity,openCodeCardMetadata } from '../src/models/opencode-model-sync.repository';
import { projectLocalJobPayload,assertProjectLocalJob } from '../src/devices/project-local-jobs';
import type { Device,DeviceStore } from '../src/devices/device-store';
import type { DeviceInstallations } from '../src/devices/device-installations';
import type { InstallPlans } from '../src/devices/install-plans';
import type { IOpenCodeModelCandidate } from '../../shared/opencode-model-scan.cjs';
const candidate:IOpenCodeModelCandidate={candidateId:randomUUID(),provider:'team',configKey:'alias',name:'Team',model:'model-id',modelVersion:'model-id',runtime:'remote-openai',baseUrl:'https://provider.example.test/v1',capability:'chat',hasKey:true,credentialSource:'file',blocker:null,options:{contextWindow:128000,temperature:0.2}};
describe('OpenCode v2 scopes and stable semantic identity',()=>{
 it('different context/temperature create different connections, identical canonical options deduplicate and keys do not participate',()=>{
  const id=openCodeIdentity(candidate);expect(openCodeIdentity({...candidate,candidateId:randomUUID(),credentialSource:'auth',hasKey:false,options:{temperature:0.2,contextWindow:128000}})).toBe(id);
  expect(openCodeIdentity({...candidate,options:{contextWindow:64000,temperature:0.2}})).not.toBe(id);
  expect(openCodeIdentity({...candidate,options:{contextWindow:128000,temperature:0.8}})).not.toBe(id);
  expect(openCodeIdentity({...candidate,timeoutMs:300000,outputTokenLimit:64000})).toBe(id);
  expect(openCodeCardMetadata(candidate,'global')).toMatchObject({name:expect.stringContaining('общая'),description:expect.stringContaining('Контекст: 128000')});
  expect(openCodeCardMetadata(candidate,'project').description).toContain('конфигурация проекта');
 });
 it('global job does not ask for a project or binding and revalidates owner/device/capability',async()=>{
  const device={id:randomUUID(),role:'Главный админ',report:{capabilities:['workspace-instance-v1','opencode-model-scan-v2'],bridgeVersion:'0.9.17',protocolVersion:2}} as Device;
  const args=[{} as DeviceStore,{} as DeviceInstallations,{} as InstallPlans] as const;
  const input={kind:'scan-opencode-models',scope:'global' as const,deviceId:device.id,requestKey:randomUUID()};
  const payload=await projectLocalJobPayload(...args,device,input);expect(payload).toEqual({scope:'global',deviceId:device.id});
  const job={id:randomUUID(),device_id:device.id,project_id:null,email:'qa@test',role:'Главный админ',kind:input.kind,payload:payload!};
  await expect(assertProjectLocalJob(...args,device,job)).resolves.toBeUndefined();
  await expect(projectLocalJobPayload(...args,device,{...input,projectId:'fake'})).rejects.toThrow();
  await expect(projectLocalJobPayload(...args,device,{...input,expectedBindingId:'a'.repeat(64)})).rejects.toThrow();
  await expect(projectLocalJobPayload(...args,{...device,role:'Разработчик'},input)).rejects.toThrow();
  await expect(projectLocalJobPayload(...args,{...device,report:{...device.report,capabilities:['opencode-model-scan-v1']}},input)).rejects.toThrow();
  await expect(assertProjectLocalJob(...args,device,{...job,payload:{scope:'global',deviceId:randomUUID()}})).rejects.toThrow();
  await expect(assertProjectLocalJob(...args,device,{...job,role:'Разработчик'})).rejects.toThrow();
 });
});
