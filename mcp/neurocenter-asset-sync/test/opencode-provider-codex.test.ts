import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parse} from 'jsonc-parser';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {codexFixture} from './opencode-provider-codex.fixture.js';
import {providerSession,noop} from './opencode-provider.fixture.js';
import {providerStatus,saveProvider} from '../src/features/opencode-providers/engine.js';
import {providerConfig,providerProof} from '../src/features/opencode-providers/receipt.js';
import {closeProviderSessions} from '../src/features/opencode-providers/server.js';
import {connectorPackage,loadConnector} from '../src/features/opencode-providers/connector.js';
import {authorizeManagedProvider} from '../src/features/opencode-providers/authorization.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{await closeProviderSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();});
async function fixture(){const f=await codexFixture();cleanup.push(f.cleanup);return f;}
describe('Managed auth-only Codex provider contract',()=>{
 it('verifies complete package and immutable runtime before importing only the trusted setup module',async()=>{
  const f=await fixture();expect(()=>connectorPackage({...f.descriptor,connector:{...f.descriptor.connector!,manifest:'f'.repeat(64)}},f.pkg)).toThrow();expect((await loadConnector(f.context)).pluginModule).toContain('codex-plugin.mjs');
  await fs.chmod(path.join(f.resolution.root,'codex-setup.mjs'),0o600);await fs.appendFile(path.join(f.resolution.root,'codex-setup.mjs'),'\n// tampered');await expect(loadConnector(f.context)).rejects.toThrow();
 });
 it('preserves manual plugins/default/provider; writes an auth-only wrapper and reads model metadata without tokens',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');await fs.mkdir(path.join(f.root,'.opencode'),{recursive:true});await fs.writeFile(path.join(f.root,providerConfig),'// KEEP\n{"model":"manual/default","plugin":[["manual-plugin",{"custom":true}]],"provider":{"manual":{}}}');
  const session={preparationId:randomUUID(),setupJobId:randomUUID()},status=await saveProvider(f.context,'qa-codex',null,noop,noop,session);expect(status).toMatchObject({ready:true,state:'configured'});
  const raw=await fs.readFile(path.join(f.root,providerConfig),'utf8'),config=parse(raw),proof=await providerProof(f.context);expect(raw).toContain('// KEEP');expect(config.model).toBe('manual/default');expect(config.plugin[0]).toEqual(['manual-plugin',{custom:true}]);expect(config.provider.manual).toEqual({});expect(config.provider[f.descriptor.providerId].options).not.toHaveProperty('apiKey');
  expect(proof!.receipt.authorization).toEqual(session);const wrapper=await fs.readFile(path.join(f.root,proof!.receipt.files![0]!.relative),'utf8');expect(wrapper).toContain(JSON.stringify(process.execPath));expect(wrapper).toContain('createManagedCodexPlugin');expect(wrapper).toContain('"codexHome":'+JSON.stringify(path.join(f.home,'.codex')));expect(JSON.stringify(status)).not.toContain(f.root);expect(status).not.toHaveProperty('models');
  vi.stubEnv('QA_CODEX_LOGGED','0');const reads=process.env.QA_CODEX_READS;expect(await providerStatus(f.context,noop)).toMatchObject({state:'configured',ready:true});expect(process.env.QA_CODEX_READS).toBe(reads);
 });
 it('the local wizard requires fresh admission, exposes only the official login link locally and cancels its owned login',async()=>{
  const f=await fixture(),s=await providerSession(f,noop,f.pkg),form=await(await s.bootstrap()).json() as {csrf:string;loginRequired:boolean};expect(form.loginRequired).toBe(true);
  const login=await s.post('/login',{},form.csrf);expect(login.status).toBe(200);expect(await login.json()).toEqual({url:'https://auth.openai.com/authorize?fixture=true'});expect(process.env.QA_CODEX_LOGINS).toBe('1');
  expect((await s.post('/login',{},form.csrf)).status).toBe(400);vi.stubEnv('QA_CODEX_LOGGED','1');expect(await(await s.post('/models',{},form.csrf)).json()).toMatchObject({loginRequired:false,models:[{id:'qa-codex'}]});
  expect(await(await s.post('/save',{modelId:'qa-codex',expectedRevision:null},form.csrf)).json()).toEqual({ready:true,state:'configured'});await closeProviderSessions();expect(process.env.QA_CODEX_CLOSED).toBe('1');
 });
 it('a disabled/revoked setup permission blocks model/login operations after the form is opened',async()=>{
  const f=await fixture();let allowed=true;const admit=async()=>{if(!allowed)throw Error('FLAG_OFF');},s=await providerSession(f,admit,f.pkg),form=await(await s.bootstrap()).json() as {csrf:string};allowed=false;const reads=process.env.QA_CODEX_READS;
  expect((await s.post('/login',{},form.csrf)).status).toBe(400);expect((await s.post('/models',{},form.csrf)).status).toBe(400);expect(process.env.QA_CODEX_LOGINS).toBe('0');expect(process.env.QA_CODEX_READS).toBe(reads);
 });
 it('every managed request rechecks the exact committed profile and fresh server permit without secrets',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');const s=await providerSession(f,noop,f.pkg),form=await(await s.bootstrap()).json() as {csrf:string};await s.post('/save',{modelId:'qa-codex',expectedRevision:null},form.csrf);
  const input={providerId:f.descriptor.providerId,projectRoot:f.root,preparationId:s.preparation.preparationId,setupJobId:s.openJobId,schemaDigest:f.descriptor.schemaDigest,phase:'request'},permit=vi.fn(async()=>({ok:true}));
  expect(await authorizeManagedProvider(input,permit)).toEqual({ok:true,allowed:true});expect(permit).toHaveBeenCalledWith({jobId:s.openJobId,providerId:f.descriptor.providerId,schemaDigest:f.descriptor.schemaDigest,phase:'request'});
  await expect(authorizeManagedProvider({...input,projectRoot:path.dirname(f.root)},permit)).rejects.toThrow();expect(permit).toHaveBeenCalledOnce();
  const proof=await providerProof(f.context);await fs.appendFile(path.join(f.root,proof!.receipt.files![0]!.relative),'\n// MANUAL');await expect(authorizeManagedProvider(input,permit)).rejects.toThrow();expect(permit).toHaveBeenCalledOnce();
 });
 it('a late local edit after server admission prevents a new managed request',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');const s=await providerSession(f,noop,f.pkg),form=await(await s.bootstrap()).json() as {csrf:string};await s.post('/save',{modelId:'qa-codex',expectedRevision:null},form.csrf);
  const proof=await providerProof(f.context),permit=vi.fn(async()=>{await fs.appendFile(path.join(f.root,proof!.receipt.files![0]!.relative),'\n// LATE');return {ok:true};});
  await expect(authorizeManagedProvider({providerId:f.descriptor.providerId,projectRoot:f.root,preparationId:s.preparation.preparationId,setupJobId:s.openJobId,schemaDigest:f.descriptor.schemaDigest,phase:'request'},permit)).rejects.toThrow();expect(permit).toHaveBeenCalledOnce();
 });
 it('rejects a manual wrapper collision and never replaces it',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');const file=path.join(f.root,'.opencode/neurocenter/providers',f.descriptor.providerId+'.mjs');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'MANUAL');
  await expect(saveProvider(f.context,'qa-codex',null,noop,noop,{preparationId:randomUUID(),setupJobId:randomUUID()})).rejects.toThrow('Конфликт');expect(await fs.readFile(file,'utf8')).toBe('MANUAL');await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('closing the local session aborts a pending trusted metadata operation',async()=>{
  const f=await fixture(),s=await providerSession(f,noop,f.pkg);vi.stubEnv('QA_CODEX_HOLD_METADATA','1');const pending=s.bootstrap().catch(()=>null);
  await vi.waitFor(()=>expect(process.env.QA_CODEX_METADATA_STARTED).toBe('1'));await closeProviderSessions();await pending;
  await vi.waitFor(()=>expect(process.env.QA_CODEX_METADATA_CANCELLED).toBe('1'));expect(process.env.QA_CODEX_LOGINS).toBe('0');await expect(fs.stat(path.join(f.root,providerConfig))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('a completed local login is closed and can be retried without reopening the wizard',async()=>{
  const f=await fixture(),s=await providerSession(f,noop,f.pkg),form=await(await s.bootstrap()).json() as {csrf:string};vi.stubEnv('QA_CODEX_IMMEDIATE_LOGIN','1');
  expect((await s.post('/login',{},form.csrf)).status).toBe(200);await vi.waitFor(()=>expect(process.env.QA_CODEX_CLOSED).toBe('1'));
  expect((await s.post('/login',{},form.csrf)).status).toBe(200);await vi.waitFor(()=>expect(process.env.QA_CODEX_CLOSED).toBe('2'));expect(process.env.QA_CODEX_LOGINS).toBe('2');
 });
 it('a replaced setup revision revokes the old wrapper permit before any server request',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');const first=await providerSession(f,noop,f.pkg),one=await(await first.bootstrap()).json() as {csrf:string};await first.post('/save',{modelId:'qa-codex',expectedRevision:null},one.csrf);
  const second=await providerSession(f,noop,f.pkg),two=await(await second.bootstrap()).json() as {csrf:string;revision:string};expect((await second.post('/save',{modelId:'qa-codex',expectedRevision:two.revision},two.csrf)).status).toBe(200);
  const permit=vi.fn(async()=>({ok:true}));await expect(authorizeManagedProvider({providerId:f.descriptor.providerId,projectRoot:f.root,preparationId:first.preparation.preparationId,setupJobId:first.openJobId,schemaDigest:f.descriptor.schemaDigest,phase:'request'},permit)).rejects.toThrow();expect(permit).not.toHaveBeenCalled();
 });
 it.each(['absolute','relative'])('a higher-priority %s tuple cannot silently change the owned plugin specification',async identity=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');await saveProvider(f.context,'qa-codex',null,noop,noop,{preparationId:randomUUID(),setupJobId:randomUUID()});const proof=await providerProof(f.context);
  vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify({plugin:[[identity==='absolute'?proof!.receipt.plugin:'./'+proof!.receipt.files![0]!.relative,{manualOverride:true}]]}));expect(await providerStatus(f.context,noop)).toMatchObject({state:'conflict',ready:false});
 });
 it('pins an explicit nonsecret Codex namespace in its owned wrapper without changing global environment',async()=>{
  const f=await fixture();vi.stubEnv('QA_CODEX_LOGGED','1');const codexHome=path.join(f.temporary,'custom Codex home');vi.stubEnv('CODEX_HOME',codexHome);
  const status=await saveProvider(f.context,'qa-codex',null,noop,noop,{preparationId:randomUUID(),setupJobId:randomUUID()}),proof=await providerProof(f.context),wrapper=await fs.readFile(path.join(f.root,proof!.receipt.files![0]!.relative),'utf8');
  expect(wrapper).toContain('"codexHome":'+JSON.stringify(codexHome));expect(process.env.CODEX_HOME).toBe(codexHome);expect(JSON.stringify(status)).not.toContain(codexHome);
 });
});
