import { describe, expect, it } from 'vitest';
import { databaseFixture, actor, tool } from './asset-import-db.fixture';
import { ProjectAssetRepository } from '../src/catalog/project-asset-repository';
import { setupProjectAssetPins, pluginDeliveryPackage } from '../src/catalog/project-asset-pins';
import { InstallPlans } from '../src/devices/install-plans';
import { setupInstallPlans } from '../src/devices/install-plan-schema';
import type { DeviceStore } from '../src/devices/device-store';
import type { DeviceArtifacts } from '../src/devices/device-artifacts';
import { nativeCardHash } from '../src/publication/native-hash';
import { assertDeviceCatalogAsset } from '../src/devices/device-catalog-access';

async function fixture(){
    const db=await databaseFixture();
    try{
        await setupProjectAssetPins(db.pool);await setupProjectAssetPins(db.pool);await setupInstallPlans(db.pool);
        await db.pool.query("INSERT INTO projects VALUES('project-a','Проект A')");
        const plugin=await db.plugins.create(tool('pin-fixture').asset.card as never,actor),first=pluginDeliveryPackage(plugin);
        const assignments=new ProjectAssetRepository(db.pool);
        const artifacts={build:async(_kind:string,id:string,version:number)=>{
            const head=await db.plugins.get(id),old=await db.plugins.version(id,version);
            if(!head||!old)throw new Error('Missing immutable fixture');
            return pluginDeliveryPackage({...head,...old.metadata,version,files:old.files,config:old.config} as typeof head);
        }} as DeviceArtifacts;
        const plans=new InstallPlans({pool:db.pool,access:{claims:async()=>({userRoles:['Главный админ'],projects:[]})}} as unknown as DeviceStore,artifacts);
        return {...db,plugin,first,assignments,plans,artifacts};
    }catch(error){await db.dispose();throw error;}
}
const admin={email:actor,activeRole:'Главный админ'};
describe('Exact project assignment — actual PostgreSQL and immutable packages',()=>{
 it('assigned v1 remains visible after common head v2 and archive, repeated add does not repin',async()=>{
    const db=await fixture();try{
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);
        const head=await db.plugins.update(db.plugin.id,{expectedVersion:1,description:'New head'},actor);expect(head?.version).toBe(2);
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);
        const client=await db.pool.connect();try{await client.query('BEGIN');await db.plugins.archive(client,db.plugin.id,actor,{expectedHash:nativeCardHash(head!),restore:false});await client.query('COMMIT');}finally{client.release();}
        const cards=await db.assignments.catalog('project-a');expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({version:1,manifest:db.first.manifest.sha256,pinOrigin:'assigned',card:{version:1,description:db.plugin.description}});
        await assertDeviceCatalogAsset(db.pool,'project-a','plugin',db.plugin.id,{version:1,manifest:db.first.manifest.sha256});
        await db.pool.query("INSERT INTO projects VALUES('project-b','Проект B')");
        await expect(db.assignments.add('project-b',db.plugin.id,'plugin',actor)).rejects.toMatchObject({status:409});
    }finally{await db.dispose();}
 });
 it('unversioned migration rows are unresolved, no implicit current fallback; manual CAS pin repairs one ref',async()=>{
    const db=await fixture();try{
        await db.pool.query("INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by) VALUES('project-a',$1,'plugin',$2)",[db.plugin.id,actor]);
        const before=await db.assignments.catalog('project-a');expect(before[0]).toMatchObject({version:null,manifest:null,pinOrigin:'unresolved'});expect(before[0].card).toBeUndefined();expect(before[0].pinError).toContain('не подтверждена');
        await expect(db.plans.prepare(admin,{projectId:'project-a',assetKind:'plugin',assetId:db.plugin.id,version:1})).rejects.toMatchObject({status:409});
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);expect((await db.assignments.catalog('project-a'))[0].pinOrigin).toBe('unresolved');
        await db.assignments.pin('project-a',db.plugin.id,'plugin',actor,{version:1,expectedVersion:null,expectedManifest:null});
        expect((await db.assignments.catalog('project-a'))[0]).toMatchObject({version:1,pinOrigin:'manual',manifest:db.first.manifest.sha256});
    }finally{await db.dispose();}
 });
 it('plan approve/delivery require root assignment exact SHA, repin invalidates prior approval',async()=>{
    const db=await fixture();try{
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);
        const plan=await db.plans.prepare(admin,{projectId:'project-a',assetKind:'plugin',assetId:db.plugin.id,version:1});
        const approved=await db.plans.decide(admin,plan.id,{expectedManifest:plan.manifest,expectedRevision:0},'approved');
        expect((await db.plans.delivery(approved.id,'project-a','plugin',db.plugin.id,1,approved.revision,approved.manifest)).package).toEqual((await db.pool.query("SELECT pin_snapshot FROM project_assets")).rows[0].pin_snapshot.package);
        await db.plugins.update(db.plugin.id,{expectedVersion:1,description:'Second'},actor);
        await db.assignments.pin('project-a',db.plugin.id,'plugin',actor,{version:2,expectedVersion:1,expectedManifest:db.first.manifest.sha256});
        await expect(db.plans.delivery(approved.id,'project-a','plugin',db.plugin.id,1,approved.revision,approved.manifest)).rejects.toMatchObject({status:409});
        await expect(db.plans.decide(admin,plan.id,{expectedManifest:approved.manifest,expectedRevision:approved.revision},'approved')).rejects.toMatchObject({status:409});
        await expect(db.plans.prepare(admin,{projectId:'project-a',assetKind:'plugin',assetId:db.plugin.id,version:1})).rejects.toMatchObject({status:409});
        expect(Number((await db.pool.query('SELECT COUNT(*) AS n FROM device_install_plans')).rows[0].n)).toBe(1);
    }finally{await db.dispose();}
 });
 it('changed pin between build and INSERT fails before a plan is saved',async()=>{
    const db=await fixture();try{
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);await db.plugins.update(db.plugin.id,{expectedVersion:1,description:'Second'},actor);
        const original=db.pool.connect.bind(db.pool);let raced=false;
        const plans=new InstallPlans({pool:{query:db.pool.query.bind(db.pool),connect:async()=>{if(!raced){raced=true;await db.assignments.pin('project-a',db.plugin.id,'plugin',actor,{version:2,expectedVersion:1,expectedManifest:db.first.manifest.sha256});}return original();}},access:{claims:async()=>({userRoles:['Главный админ'],projects:[]})}} as unknown as DeviceStore,db.artifacts);
        await expect(plans.prepare(admin,{projectId:'project-a',assetKind:'plugin',assetId:db.plugin.id,version:1})).rejects.toMatchObject({status:409});
        expect((await db.pool.query('SELECT * FROM device_install_plans')).rowCount).toBe(0);
    }finally{await db.dispose();}
 });
 it('approval waits for concurrent assignment writer then rejects changed pin, without an approval audit',async()=>{
    const db=await fixture();try{
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);
        const plan=await db.plans.prepare(admin,{projectId:'project-a',assetKind:'plugin',assetId:db.plugin.id,version:1});
        const head=await db.plugins.update(db.plugin.id,{expectedVersion:1,description:'Second'},actor),pkg=pluginDeliveryPackage(head!);
        const writer=await db.pool.connect();try{
            await writer.query('BEGIN');await writer.query("UPDATE project_assets SET asset_version=2,asset_manifest=$1,pin_snapshot=$2 WHERE project_id='project-a'",[pkg.manifest.sha256,JSON.stringify({card:head,package:pkg})]);
            const decision=db.plans.decide(admin,plan.id,{expectedManifest:plan.manifest,expectedRevision:0},'approved').then(()=>null,error=>error);
            await writer.query('COMMIT');expect(await decision).toMatchObject({status:409});
        }finally{writer.release();}
        expect((await db.pool.query('SELECT status,revision FROM device_install_plans')).rows[0]).toEqual({status:'pending',revision:0});
        expect((await db.pool.query("SELECT 1 FROM security_events WHERE action='installation.approved'")).rowCount).toBe(0);
    }finally{await db.dispose();}
 });
 it('CAS repin rejects stale or forged old manifest and package corruption is never a ready card',async()=>{
    const db=await fixture();try{
        await db.assignments.add('project-a',db.plugin.id,'plugin',actor);
        await expect(db.assignments.pin('project-a',db.plugin.id,'plugin',actor,{version:1,expectedVersion:1,expectedManifest:'f'.repeat(64)})).rejects.toMatchObject({status:409});
        await db.pool.query("UPDATE project_assets SET pin_snapshot=jsonb_set(pin_snapshot,'{package,files,0,content}','\"Corruption\"'::jsonb) WHERE project_id='project-a'");
        expect((await db.assignments.catalog('project-a'))[0].pinError).toContain('Целостность');
        await expect(assertDeviceCatalogAsset(db.pool,'project-a','plugin',db.plugin.id,{version:1,manifest:db.first.manifest.sha256})).rejects.toMatchObject({status:409});
    }finally{await db.dispose();}
 });
});
