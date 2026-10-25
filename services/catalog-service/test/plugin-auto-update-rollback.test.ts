import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {PluginAutoUpdateRepository} from '../src/plugin-auto-updates/auto-update.repository';

it.each(['confirmed','not-dispatched','ack-lost'] as const)('policy failure retains the primary error and discards an uncertain transaction: %s',async mode=>{
 const primary=Object.assign(new Error('Audit acknowledgement lost'),{code:'ECONNRESET'}),release=vi.fn();
 const row={id:randomUUID(),enabled:true,revision:1,project_id:'prj-fixture',device_id:'owned',binding_id:'a'.repeat(64),asset_id:'plugin-fixture'};
 const query=vi.fn(async(sql:string)=>{
  if(sql.startsWith('INSERT INTO security_events'))throw primary;
  if(sql==='ROLLBACK'&&mode!=='confirmed')throw new Error('Rollback acknowledgement unknown');
  return {rows:sql.startsWith('INSERT INTO plugin_auto_update_policies')?[row]:[]};
 });
 const pool={connect:async()=>({query,release})} as unknown as ConstructorParameters<typeof PluginAutoUpdateRepository>[0];
 await expect(new PluginAutoUpdateRepository(pool).save({email:'qa@example.test',activeRole:'Разработчик'},
  {deviceId:'owned',projectId:'prj-fixture',bindingId:'a'.repeat(64),assetId:'plugin-fixture',enabled:true,expectedRevision:0,requestKey:randomUUID()})).rejects.toBe(primary);
 expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO plugin_auto_update_policies'))).toHaveLength(1);
 expect(query.mock.calls.filter(([sql])=>sql==='ROLLBACK')).toHaveLength(1);
 expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
 if(mode==='confirmed')expect(release).toHaveBeenCalledExactlyOnceWith();else expect(release).toHaveBeenCalledExactlyOnceWith(true);
});
