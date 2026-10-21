import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {NotFoundException} from '@nestjs/common';
import {databaseFixture} from './asset-import-db.fixture';
import {BridgeSourceService} from '../src/asset-sources/bridge-source.service';

describe('Автономная проверка моста сохраняет честное состояние upstream',()=>{
    let f:Awaited<ReturnType<typeof databaseFixture>>;
    beforeEach(async()=>{f=await databaseFixture();vi.stubEnv('ASSET_SOURCE_MODE','offline');});
    afterEach(async()=>{vi.unstubAllEnvs();await f?.dispose();});
    it('Повторная POST-проверка без поставки не идёт в GitHub и не создаёт checkedAt/available',async()=>{
        const request=vi.fn(async()=>{throw new Error('Сеть запрещена');});vi.stubGlobal('fetch',request);
        try{
            const source={pool:f.pool,bridgeSupply:vi.fn(async()=>{throw new NotFoundException('Мост не импортирован');})};
            const service=new BridgeSourceService(source as never,{} as never),before=await service.view();
            const view=await service.check({expectedRevision:before.revision,force:true});
            expect(view).toEqual(before);expect(view.sourceMode).toBe('offline');expect(view.checkedAt).toBeUndefined();expect(view.available).toBeUndefined();expect(request).not.toHaveBeenCalled();
            await expect(service.check({expectedRevision:before.revision+1})).rejects.toMatchObject({status:409});
            expect((await f.pool.query('SELECT * FROM bridge_source_checks')).rows).toEqual([]);
        }finally{vi.unstubAllGlobals();}
    });
});
