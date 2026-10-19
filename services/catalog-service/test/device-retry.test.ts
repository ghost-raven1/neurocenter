import {beforeEach,describe,expect,it,vi} from 'vitest';
import {DeviceJobs} from '../src/devices/device-jobs';
import type {DeviceStore} from '../src/devices/device-store';
import type {DeviceArtifacts} from '../src/devices/device-artifacts';
import type {DeviceInstallations} from '../src/devices/device-installations';

describe('Повтор задания MCP',()=>{
    const actor={email:'owner@example.test',activeRole:'Разработчик'};const query=vi.fn();const service=new DeviceJobs({pool:{query}} as unknown as DeviceStore,{} as DeviceArtifacts,{} as DeviceInstallations);
    const key='12345678-1234-1234-1234-123456789abc';const original={id:'original',email:actor.email,device_id:'computer',project_id:'project',kind:'install',state:'failed',payload:{assetId:'helper',assetKind:'mcp',version:2,planId:key,planRevision:1,package:{manifest:{sha256:'a'.repeat(64)}}}};
    const create=vi.spyOn(service,'create');
    beforeEach(()=>{query.mockReset();create.mockReset();query.mockResolvedValue({rows:[original]});create.mockResolvedValue({id:'new'});});
    it('Создаёт новое задание с исходным планом и хэшем вместо чтения нового head',async()=>{await service.retry(actor,'original',key);expect(query.mock.calls[0][1]).toEqual(['original',actor.email]);expect(create).toHaveBeenCalledWith(actor,expect.objectContaining({deviceId:'computer',projectId:'project',kind:'install',assetId:'helper',version:2,requestKey:key,planId:key,planRevision:1,expectedManifest:'a'.repeat(64)}));});
    it('Старое задание без закреплённого плана требует нового просмотра',async()=>{query.mockResolvedValue({rows:[{...original,payload:{assetId:'helper',version:2}}]});await expect(service.retry(actor,'original',key)).rejects.toMatchObject({status:409});expect(create).not.toHaveBeenCalled();});
    it.each(['queued','running','succeeded'])('Не повторяет незавершённое или успешное задание: %s',async state=>{query.mockResolvedValue({rows:[{...original,state}]});await expect(service.retry(actor,'original',key)).rejects.toMatchObject({status:409});expect(create).not.toHaveBeenCalled();});
    it('Не выдаёт чужой ID и не принимает запрос без ключа',async()=>{query.mockResolvedValue({rows:[]});await expect(service.retry(actor,'foreign',key)).rejects.toMatchObject({status:404});await expect(service.retry(actor,'original','')).rejects.toMatchObject({status:400});});
});
