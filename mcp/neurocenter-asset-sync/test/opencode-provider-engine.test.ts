import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {parse} from 'jsonc-parser';
import {providerFixture,noop} from './opencode-provider.fixture.js';
import {saveProvider,providerStatus} from '../src/features/opencode-providers/engine.js';
import {providerConfig,receiptFile,providerProof} from '../src/features/opencode-providers/receipt.js';
import {createProviderCredential,providerCredentialPresent} from '../src/features/opencode-providers/credential.js';
import {writeState} from '../src/bridge/state.js';
import {providerContext} from '../src/features/opencode-providers/context.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});
async function fixture(){const f=await providerFixture();cleanup.push(f.cleanup);return f;}
describe('Managed OpenCode provider filesystem transaction',()=>{
 it('writes one native provider, preserves comments/default/plugins/other providers and keeps raw key private',async()=>{
  const f=await fixture(),file=path.join(f.root,providerConfig);await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,'// KEEP COMMENT\n{"model":"manual/default","plugin":["manual-plugin"],"provider":{"manual":{"models":{"m":{}}}}}\n');
  const result=await saveProvider(f.context,'LOCAL_SECRET_ONLY',null,noop);expect(result).toMatchObject({state:'configured',ready:true});
  const raw=await fs.readFile(file,'utf8'),config=parse(raw);expect(raw).toContain('// KEEP COMMENT');expect(config).toMatchObject({model:'manual/default',plugin:['manual-plugin'],provider:{manual:{models:{m:{}}}}});
  const proof=await providerProof(f.context);expect(proof).not.toBeNull();expect(await fs.readFile(proof!.receipt.credentialFile,'utf8')).toBe('LOCAL_SECRET_ONLY');expect((await fs.stat(proof!.receipt.credentialFile)).mode&0o777).toBe(0o600);
  for(const output of [raw,await fs.readFile(path.join(f.root,receiptFile(f.descriptor.providerId)),'utf8'),JSON.stringify(result)])expect(output).not.toContain('LOCAL_SECRET_ONLY');
  expect(JSON.stringify(result)).not.toContain('provider.example');expect(result).not.toHaveProperty('expectations');expect(config.provider[f.descriptor.providerId].options.apiKey).toBe('{file:'+proof!.receipt.credentialFile+'}');
 });
 it('keeps the existing private credential on a second revision and does not change unrelated manual edits',async()=>{
  const f=await fixture(),first=await saveProvider(f.context,'UNCHANGED_KEY',null,noop),proof=await providerProof(f.context),file=path.join(f.root,providerConfig);
  await fs.appendFile(file,'\n// NEW MANUAL COMMENT\n');const next=await saveProvider(f.context,undefined,first.revision,noop);
  expect(next.ready).toBe(true);expect(next.revision).not.toBe(first.revision);expect((await providerProof(f.context))!.receipt.credentialFile).toBe(proof!.receipt.credentialFile);expect(await fs.readFile(file,'utf8')).toContain('NEW MANUAL COMMENT');
 });
 it('an authorized new catalog pin can update its owned provider using the previous revision',async()=>{
  const f=await fixture(),first=await saveProvider(f.context,'UNCHANGED_KEY',null,noop),next=await providerContext({...f.descriptor,schemaDigest:'d'.repeat(64),expectations:{...f.descriptor.expectations!,modelPin:'e'.repeat(64),options:{temperature:0.7}}},noop);
  expect(await providerStatus(next,noop)).toMatchObject({state:'conflict',revision:first.revision});expect((await saveProvider(next,undefined,first.revision,noop)).ready).toBe(true);
 });
 it.each(['manual-entry','forged-receipt','duplicate-json'])('preserves a conflicting %s before writing secrets',async kind=>{
  const f=await fixture(),file=path.join(f.root,providerConfig);await fs.mkdir(path.dirname(file),{recursive:true});
  const body=kind==='duplicate-json'?' {"provider":{},"provider":{}}':JSON.stringify({provider:{[f.descriptor.providerId]:{models:{manual:{}}}}});await fs.writeFile(file,body);
  if(kind==='forged-receipt'){await fs.mkdir(path.dirname(path.join(f.root,receiptFile(f.descriptor.providerId))),{recursive:true});await fs.writeFile(path.join(f.root,receiptFile(f.descriptor.providerId)),'{}');}
  await expect(saveProvider(f.context,'NEVER_WRITE',null,noop)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(body);
 });
 it('refuses edited owned provider and a stale revision without overwriting either',async()=>{
  const f=await fixture(),first=await saveProvider(f.context,'LOCAL_KEY',null,noop),file=path.join(f.root,providerConfig),body=await fs.readFile(file,'utf8');
  await expect(saveProvider(f.context,'NEW_KEY',null,noop)).rejects.toThrow();await fs.writeFile(file,body.replace('Neurocenter','Manual edit'));
  await expect(saveProvider(f.context,'NEW_KEY',first.revision,noop)).rejects.toThrow();expect((await providerStatus(f.context,noop)).state).toBe('conflict');expect(await fs.readFile(file,'utf8')).toContain('Manual edit');
 });
 it('an empty global manual provider still owns its namespace and cannot be silently replaced',async()=>{
  const f=await fixture(),file=path.join(f.home,'.config/opencode/opencode.json');await fs.mkdir(path.dirname(file),{recursive:true});const raw=JSON.stringify({provider:{[f.descriptor.providerId]:{models:{}}}});await fs.writeFile(file,raw);
  await expect(saveProvider(f.context,'NEVER_WRITE',null,noop)).rejects.toThrow('Конфликт');expect(await fs.readFile(file,'utf8')).toBe(raw);await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it.each(['url','credential','disabled','model'])('does not report configured when a higher priority layer overrides %s',async field=>{
  const f=await fixture();await saveProvider(f.context,'PRIVATE_KEY',null,noop);
  const provider=field==='url'?{options:{baseURL:'https://different.example.test/v1'}}:field==='credential'?{options:{apiKey:'DIFFERENT_KEY'}}:{models:{other:{}}};
  vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify(field==='disabled'?{disabled_providers:[f.descriptor.providerId]}:{provider:{[f.descriptor.providerId]:provider}}));
  expect((await providerStatus(f.context,noop)).state).toBe('conflict');
 });
 it('revoked save admission and changed device leave project and private key untouched',async()=>{
  const f=await fixture(),reject=vi.fn(async()=>{throw Error('REVOKED');});await expect(saveProvider(f.context,'NEVER_WRITE',null,reject)).rejects.toThrow('REVOKED');
  await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
  await writeState('credentials',{deviceId:'other',token:'other'});await expect(saveProvider(f.context,'NEVER_WRITE',null,noop)).rejects.toThrow('устарела');
 });
 it('the last admission closes the await gap and preserves concurrent file edits',async()=>{
  const f=await fixture();let calls=0;const authorize=async()=>{if(++calls===2){await fs.mkdir(path.join(f.root,'.opencode'),{recursive:true});await fs.writeFile(path.join(f.root,providerConfig),'// CONCURRENT\n{}');}};
  await expect(saveProvider(f.context,'PRIVATE_KEY',null,authorize)).rejects.toThrow();expect(await fs.readFile(path.join(f.root,providerConfig),'utf8')).toBe('// CONCURRENT\n{}');
 });
 it('missing, symlinked and public-mode private key files are never configured',async()=>{
  const f=await fixture();await saveProvider(f.context,'PRIVATE_KEY',null,noop);const key=(await providerProof(f.context))!.receipt.credentialFile;
  await fs.chmod(key,0o644);await expect(providerStatus(f.context,noop)).rejects.toThrow('хранилище');await fs.chmod(key,0o600);await fs.unlink(key);
  expect(await providerStatus(f.context,noop)).toMatchObject({ready:false,missingFields:['credential']});
  const foreign=path.join(f.temporary,'foreign');await fs.writeFile(foreign,'PRIVATE_KEY',{mode:0o600});await fs.symlink(foreign,key);await expect(providerCredentialPresent(key)).rejects.toThrow();
 });
 it.each(['','has whitespace','line\nbreak','{file:other}'])('rejects malformed local credential %j',async key=>{await fixture();await expect(createProviderCredential(key)).rejects.toThrow();});
});
