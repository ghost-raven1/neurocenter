import { describe, expect, it, vi } from 'vitest';
import type { IAiPlugin, IProjectAsset, ISkillFile } from '../src/core/api/interfaces';
import { mergeProjectCatalog } from '../src/modules/Store/projectCatalogSnapshots';
import { fromPlugin } from '../src/features/Catalog/catalogCards';
import { loadStoreDetail } from '../src/modules/Store/storeDetails';
const plugin=(version:number):IAiPlugin=>({id:'ai-plug-fixture',name:'Fixture',kind:'plugin',description:'Version '+version,version,tags:[],origin:'upload',config:{entrypoint:'index.mjs'},files:[{path:'index.mjs',content:'Version '+version}],createdAt:'2026-01-01',updatedAt:'2026-01-01',compatibility:null,revision:null});
const ref=(card=plugin(1)):IProjectAsset=>({assetId:card.id,assetKind:card.kind,addedBy:'admin',addedAt:'2026-01-01',version:card.version,manifest:'a'.repeat(64),pinOrigin:'assigned',card});
describe('Project catalog snapshots',()=>{
 it('Pinned v1 replaces active common v2 and remains visible after catalog-only archive',()=>{
    expect(mergeProjectCatalog([fromPlugin(plugin(2))],[ref()])).toMatchObject([{version:1,description:'Version 1',projectManifest:'a'.repeat(64)}]);
    expect(mergeProjectCatalog([],[ref()])).toMatchObject([{id:'ai-plug-fixture',version:1}]);
 });
 it('Project detail uses the same snapshot without fetching the mutable head',async()=>{
    const app=mergeProjectCatalog([fromPlugin(plugin(2))],[ref()])[0],getAiPlugin=vi.fn(),getSkill=vi.fn();
    expect(await loadStoreDetail({getAiPlugin,getSkill},app)).toEqual({kind:'bundle',plugin:plugin(1)});expect(getAiPlugin).not.toHaveBeenCalled();
 });
 it('Unresolved or corrupt project pin never silently inherits executable common head',()=>{
    const unresolved={...ref(),version:null,manifest:null,pinOrigin:'unresolved' as const,card:undefined};
    expect(mergeProjectCatalog([fromPlugin(plugin(2))],[unresolved])[0].pinError).toContain('не подтверждена');
    expect(mergeProjectCatalog([fromPlugin(plugin(2))],[{...ref(),pinError:'Corrupt snapshot'}])[0].pinError).toBe('Corrupt snapshot');
 });
 it('Historical skill body and resources remain exact after a common update',async()=>{
    const skill={path:'common/helper',meta:{name:'Helper',slug:'helper',version:1,tags:[]},body:'Old body',resources:[{path:'guide.txt',content:'Old resource'}]} as ISkillFile;
    const app=mergeProjectCatalog([],[{...ref(),assetKind:'skill',assetId:skill.path,card:skill}])[0];
    expect(app.version).toBe(1);expect(await loadStoreDetail({getAiPlugin:vi.fn(),getSkill:vi.fn()},app)).toEqual({kind:'skill',skill});
 });
 it('Switching projects uses only the new project snapshots',()=>{
    const common=[fromPlugin(plugin(2))];const first=mergeProjectCatalog(common,[ref()]);
    expect(first[0].version).toBe(1);expect(mergeProjectCatalog(common,[])[0]).toMatchObject({version:2});expect(common[0].projectCard).toBeUndefined();
 });
});
