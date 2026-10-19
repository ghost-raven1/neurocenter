import { describe, it, expect } from 'vitest';
import { assertProjectInventory, assertLocalVariants } from '../src/devices/project-local-reports';

const source={projectId:'project',bindingId:'b'.repeat(64),instanceId:'11111111-1111-4111-8111-111111111111',
    package:{plugin:{id:'asset',kind:'skill',version:1},manifest:{sha256:'a'.repeat(64)}}};
const inventory={schemaVersion:1,...{projectId:source.projectId,bindingId:source.bindingId,instanceId:source.instanceId},
    scanId:'22222222-2222-4222-8222-222222222222',digest:'c'.repeat(64),checkedAt:'2026-10-18T00:00:00.000Z',expiresAt:'2026-10-18T00:15:00.000Z',complete:true,issues:[],
    entries:[{candidateId:'33333333-3333-4333-8333-333333333333',kind:'skill',path:'.opencode/skills/example',state:'unmanaged',reason:'unmanaged-files'}]};
const variants={schemaVersion:1,projectId:source.projectId,bindingId:source.bindingId,instanceId:source.instanceId,assetId:'asset',assetKind:'skill',version:1,manifest:'a'.repeat(64),
    checkedAt:'2026-10-18T00:00:00.000Z',complete:true,entries:[{recoveryId:'44444444-4444-4444-8444-444444444444',createdAt:'2026-10-17T00:00:00.000Z',files:2,eligible:true,reason:'ready'}]};

describe('Приватные данные не проходят в отчётах инвентаризации и копий',()=>{
    it('Принимает только ограниченную метаинформацию своего экземпляра',()=>{
        expect(()=>assertProjectInventory(inventory,source)).not.toThrow();expect(()=>assertLocalVariants(variants,source)).not.toThrow();
    });
    it.each(['command','content','config','stdout','reportPath'])('Отвергает поле %s с потенциальными секретами',key=>{
        expect(()=>assertProjectInventory({...inventory,[key]:'секрет'},source)).toThrow();
        expect(()=>assertLocalVariants({...variants,[key]:'секрет'},source)).toThrow();
    });
    it.each(['/etc/private','../private','C:/private','.opencode/../private','.opencode\\private'])('Не принимает путь %s',path=>{
        expect(()=>assertProjectInventory({...inventory,entries:[{...inventory.entries[0],path}]},source)).toThrow();
    });
    it('Не принимает чужой экземпляр, произвольные причины и повтор идентификатора',()=>{
        expect(()=>assertProjectInventory({...inventory,instanceId:'55555555-5555-4555-8555-555555555555'},source)).toThrow();
        expect(()=>assertProjectInventory({...inventory,issues:['PRIVATE_SECRET']},source)).toThrow();
        expect(()=>assertProjectInventory({...inventory,entries:[inventory.entries[0],inventory.entries[0]]},source)).toThrow();
        expect(()=>assertLocalVariants({...variants,entries:[{...variants.entries[0],reason:'legacy-unverified'}]},source)).toThrow();
    });
    it('Ограничивает количество и содержимое записей',()=>{
        expect(()=>assertProjectInventory({...inventory,entries:Array(201).fill(inventory.entries[0])},source)).toThrow();
        expect(()=>assertLocalVariants({...variants,entries:Array(101).fill(variants.entries[0])},source)).toThrow();
        expect(()=>assertLocalVariants({...variants,entries:[{...variants.entries[0],before:'секрет'}]},source)).toThrow();
    });
});
