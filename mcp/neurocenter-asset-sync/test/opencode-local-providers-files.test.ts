import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {GlobalProviderEditor} from '../src/features/opencode-local-providers/editor.js';
const roots:string[]=[];
const fixture=async()=>{const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc global provider ')));roots.push(home);const config=path.join(home,'.config/opencode'),data=path.join(home,'.local/share/opencode');await fs.mkdir(config,{recursive:true});await fs.mkdir(data,{recursive:true});return{home,config,data,authorize:vi.fn(async()=>{}),compatible:vi.fn(async()=>({assertCurrent:async()=>{}}))};};
afterEach(async()=>{for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true});});
it('reads the pinned global JSON then JSONC layers and auth-only providers without credential values or fingerprints',async()=>{
    const f=await fixture(),secret='SYNTHETIC_CREDENTIAL_789';
    await fs.writeFile(path.join(f.config,'opencode.json'),' {"provider":{"local":{"models":{"one":{}}}}}');
    await fs.writeFile(path.join(f.config,'opencode.jsonc'),'// manual\n{"provider":{"local":{"models":{"two":{}}}},"disabled_providers":["local"]}');
    await fs.writeFile(path.join(f.data,'auth.json'),JSON.stringify({openai:{type:'oauth',access:secret,refresh:secret,expires:42},team:{type:'api',key:secret},broken:{type:'api',key:secret,metadata:{invalid:42}}}),{mode:0o600});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});const inventory=await editor.inventory();
    expect(inventory.providers).toEqual(expect.arrayContaining([expect.objectContaining({id:'local',modelIds:['one','two'],enabled:false}),expect.objectContaining({id:'openai',authentication:'oauth',hasAuthentication:true}),expect.objectContaining({id:'team',authentication:'api'})]));
    expect(inventory.providers.find(row=>row.id==='broken')).toMatchObject({authentication:'unknown',hasAuthentication:false});
    expect(JSON.stringify(inventory)).not.toContain(secret);expect(JSON.stringify(inventory)).not.toContain('sha256');
});
it('rotates only the selected API entry and keeps OAuth, unknown fields and JSONC comments unchanged',async()=>{
    const f=await fixture(),raw='// manual comment\n{"provider":{"team":{"options":{"baseURL":"https://team.invalid/v1"},"models":{"chat":{}}}},"model":"team/chat"}\n';
    await fs.writeFile(path.join(f.config,'opencode.jsonc'),raw);const auth={team:{type:'api',key:'OLD',metadata:{accountId:'manual'},unknown:[1]},other:{type:'oauth',access:'KEEP',refresh:'KEEP',expires:42},unknown:{custom:true}};
    await fs.writeFile(path.join(f.data,'auth.json'),JSON.stringify(auth),{mode:0o600});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});const preview=await editor.prepare({providerId:'team',authentication:'api',apiKey:'NEW_SYNTHETIC_KEY'});await editor.save({previewId:preview.previewId});
    expect(await fs.readFile(path.join(f.config,'opencode.jsonc'),'utf8')).toBe(raw);expect(JSON.parse(await fs.readFile(path.join(f.data,'auth.json'),'utf8'))).toEqual({...auth,team:{...auth.team,key:'NEW_SYNTHETIC_KEY'}});
    expect((await fs.stat(path.join(f.data,'auth.json'))).mode&0o077).toBe(0);
});
it('a new keyless custom provider writes targeted JSONC fields without selecting a default model or creating auth',async()=>{
    const f=await fixture();await fs.writeFile(path.join(f.config,'opencode.jsonc'),'// retained\n{"plugin":["manual"],"model":"other/model"}\n');
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});const preview=await editor.prepare({providerId:'local',authentication:'none',baseURL:'http://127.0.0.1:11434/v1',modelIds:['tiny']});await editor.save({previewId:preview.previewId});
    const raw=await fs.readFile(path.join(f.config,'opencode.jsonc'),'utf8');expect(raw).toContain('// retained');expect(raw).toContain('other/model');expect(raw).toContain('@ai-sdk/openai-compatible');await expect(fs.stat(path.join(f.data,'auth.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('malformed auth and concurrent auth rotation fail without replacing either file or silently using an empty auth map',async()=>{
    const f=await fixture(),file=path.join(f.data,'auth.json');await fs.writeFile(file,'BROKEN_AUTH',{mode:0o600});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});expect((await editor.inventory()).issues).toContain('invalid-json');await expect(editor.prepare({providerId:'team',authentication:'api',apiKey:'NEW'})).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe('BROKEN_AUTH');
    await fs.writeFile(file,'{"team":{"type":"api","key":"OLD"}}',{mode:0o600});const preview=await editor.prepare({providerId:'team',authentication:'api',apiKey:'NEW'});const changed='{"team":{"type":"api","key":"EXTERNAL_ROTATION"}}';await fs.writeFile(file,changed);await expect(editor.save({previewId:preview.previewId})).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(changed);
});
it('OAuth and a manual config key cannot be overwritten implicitly, and revoked save authority leaves bytes unchanged',async()=>{
    const f=await fixture(),file=path.join(f.data,'auth.json'),raw='{"openai":{"type":"oauth","access":"KEEP","refresh":"KEEP","expires":42}}';await fs.writeFile(file,raw,{mode:0o600});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});await expect(editor.prepare({providerId:'openai',authentication:'api',apiKey:'NEW'})).rejects.toThrow();
    const prepared=await editor.prepare({providerId:'team',authentication:'api',apiKey:'NEW'});f.authorize.mockRejectedValueOnce(Error('REVOKED'));await expect(editor.save({previewId:prepared.previewId})).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(raw);
});
it('a partial two-file save survives a new editor; explicit recovery finishes only the uncommitted file',async()=>{
    const f=await fixture(),configFile=path.join(f.config,'opencode.jsonc'),authFile=path.join(f.data,'auth.json');let interrupt=true;
    f.authorize.mockImplementation(async()=>{if(interrupt&&await fs.readFile(configFile,'utf8').then(text=>text.includes('local'),()=>false)){interrupt=false;throw Error('CONTROLLED_AUTH_REVOKE_AFTER_CONFIG');}});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});const preview=await editor.prepare({providerId:'local',authentication:'api',apiKey:'SYNTHETIC_PRIVATE_NEW',baseURL:'http://127.0.0.1:11434/v1',modelIds:['one']});
    await expect(editor.save({previewId:preview.previewId})).rejects.toMatchObject({code:'GLOBAL_PROVIDER_UNKNOWN'});await expect(fs.stat(authFile)).rejects.toMatchObject({code:'ENOENT'});
    const configInode=(await fs.stat(configFile)).ino,fresh=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible}),status=await fresh.lastSave();expect(status?.status).toBe('partial');
    await expect(fresh.prepare({providerId:'other',authentication:'api',apiKey:'OTHER'})).rejects.toThrow();
    await fresh.resume({intentId:status!.intentId});expect((await fs.stat(configFile)).ino).toBe(configInode);expect(JSON.parse(await fs.readFile(authFile,'utf8')).local.key).toBe('SYNTHETIC_PRIVATE_NEW');
    expect((await fresh.lastSave())?.status).toBe('saved');expect(JSON.stringify(await fresh.inventory())).not.toContain('SYNTHETIC_PRIVATE_NEW');
});
it('lost save ACK reconciles committed private intent without writing auth or configuration again',async()=>{
    const f=await fixture(),authFile=path.join(f.data,'auth.json'),editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});
    const preview=await editor.prepare({providerId:'openai',authentication:'api',apiKey:'SYNTHETIC_PRIVATE_ACK'});await editor.save({previewId:preview.previewId});
    const inode=(await fs.stat(authFile)).ino,fresh=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible}),status=await fresh.lastSave();expect(status?.status).toBe('saved');await fresh.resume({intentId:status!.intentId});expect((await fs.stat(authFile)).ino).toBe(inode);
});
it('XDG overrides are scoped, environment overrides block ineffective saves and symlinked auth is never followed',async()=>{
    const f=await fixture(),other=path.join(f.home,'xdg-data');await fs.mkdir(path.join(other,'opencode'),{recursive:true});await fs.writeFile(path.join(other,'opencode/auth.json'),'{"openai":{"type":"api","key":"XDG_PRIVATE"}}',{mode:0o600});
    const editor=new GlobalProviderEditor({home:f.home,environment:{XDG_DATA_HOME:other},authorize:f.authorize,assertCompatibleCli:f.compatible});expect((await editor.inventory()).providers[0]?.id).toBe('openai');
    const overridden=new GlobalProviderEditor({home:f.home,environment:{OPENCODE_AUTH_CONTENT:'PRIVATE_OVERRIDDEN'},authorize:f.authorize,assertCompatibleCli:f.compatible});expect((await overridden.inventory()).issues).toContain('environment-override');await expect(overridden.prepare({providerId:'team',authentication:'api',apiKey:'NEW'})).rejects.toThrow();
    await fs.symlink(path.join(other,'opencode/auth.json'),path.join(f.data,'auth.json'));expect((await new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible}).inventory()).issues).toContain('unsafe-file');expect(await fs.readFile(path.join(other,'opencode/auth.json'),'utf8')).toContain('XDG_PRIVATE');
});

it('a newer or unverified ordinary CLI is rejected before any private intent or auth publication; safe reads remain available',async()=>{
    const f=await fixture();f.compatible.mockRejectedValue(Object.assign(Error('Only ordinary1.14.48'),{code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'}));
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible});expect((await editor.inventory()).issues).toEqual([]);expect(f.compatible).not.toHaveBeenCalled();
    const preview=await editor.prepare({providerId:'openai',authentication:'api',apiKey:'SYNTHETIC_UNSUPPORTED'});await expect(editor.save({previewId:preview.previewId})).rejects.toMatchObject({code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'});
    await expect(fs.stat(path.join(f.data,'auth.json'))).rejects.toMatchObject({code:'ENOENT'});expect(await editor.lastSave()).toBeUndefined();
});
it('the returned CLI fingerprint guard fences a file replacement during the final authorization await',async()=>{
    const f=await fixture(),cli=path.join(f.home,'ordinary-cli'),intent=path.join(f.home,'.local/state/neurocenter/opencode-global-providers/intent.json');await fs.writeFile(cli,'pinned-1.14.48');
    f.compatible.mockResolvedValue({assertCurrent:async()=>{if(await fs.readFile(cli,'utf8')!=='pinned-1.14.48')throw Object.assign(Error('CLI changed'),{code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'});}});
    f.authorize.mockImplementation(async()=>{if(await fs.stat(intent).then(()=>true,()=>false))await fs.writeFile(cli,'newer-cli');});
    const editor=new GlobalProviderEditor({home:f.home,environment:{},authorize:f.authorize,assertCompatibleCli:f.compatible}),preview=await editor.prepare({providerId:'openai',authentication:'api',apiKey:'SYNTHETIC_PRIVATE_ROTATION'});
    await expect(editor.save({previewId:preview.previewId})).rejects.toMatchObject({code:'OPENCODE_GLOBAL_PROVIDER_CLI_UNSUPPORTED'});await expect(fs.stat(path.join(f.data,'auth.json'))).rejects.toMatchObject({code:'ENOENT'});expect((await editor.lastSave())?.status).toBe('not-applied');
});
