import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { assertDeviceCatalogAsset } from '../src/devices/device-catalog-access';
import { CatalogService } from '../src/catalog/catalog.service';

describe('Canonical skill assignments only',()=>{
    it('Unresolved short reference cannot authorize a different full path or fetch a guessed head',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[],rowCount:0}),request=vi.spyOn(globalThis,'fetch');
        try{await expect(assertDeviceCatalogAsset({query} as unknown as Pool,'prj-own','skill','common/helper')).rejects.toMatchObject({status:403});expect(query).toHaveBeenCalledTimes(1);expect(request).not.toHaveBeenCalled();}finally{request.mockRestore();}
    });
    it('A new assignment rejects a short slug before any native lookup',async()=>{
        const request=vi.spyOn(globalThis,'fetch');
        try{await expect(CatalogService.prototype.addProjectAsset.call({} as CatalogService,'prj-own','helper','skill','admin@example.test')).rejects.toMatchObject({status:400});expect(request).not.toHaveBeenCalled();}finally{request.mockRestore();}
    });
    it('Canonical exact row authorizes only its project and never another project scope',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[{asset_id:'common/helper',asset_kind:'skill'}],rowCount:1});
        await assertDeviceCatalogAsset({query} as unknown as Pool,'prj-own','skill','common/helper');
        expect(query.mock.calls[0][1]).toEqual(['prj-own','skill','common/helper']);
        await expect(assertDeviceCatalogAsset({query} as unknown as Pool,'prj-own','skill','project-prj-other/helper')).rejects.toMatchObject({status:403});
    });
});
