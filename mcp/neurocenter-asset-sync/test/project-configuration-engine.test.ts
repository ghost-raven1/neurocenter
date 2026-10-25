import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {configurationFixture} from './project-configuration.fixture.js';
import {closeConfigurationSessions} from '../src/features/project-configuration/server.js';
import {journalDirectory,parseJournal} from '../src/bridge/installation-journal.js';
import {writePrivateConfiguration} from '../src/features/local-configuration/private-store.js';
import {profileKey} from '../src/features/rag-hosted/profile.js';
import {hash,jobContext} from '../src/bridge/state.js';
import {pendingCompletions} from '../src/bridge/completions.js';
import {commitChanges} from '../src/bridge/installation-files.js';
import {agentFile,AGENTS_RECEIPT,agentsJournalKey} from '../src/features/project-agents/receipt.js';
import {ragFields,updateRagFields,configurationObject,preserveRagProfile} from '../src/features/project-configuration/json.js';
const cleanup:Array<()=>Promise<void>>=[];
async function fixture(){const f=await configurationFixture();cleanup.push(f.cleanup);return f;}
afterEach(async()=>{await closeConfigurationSessions();await Promise.all(cleanup.splice(0).map(fn=>fn()));vi.unstubAllEnvs();vi.restoreAllMocks();});
describe('Local project configuration transactions',()=>{
 it('finds bounded known files, skips dependencies and symlinks, and creates only the explicitly selected file',async()=>{
    const f=await fixture();await fs.mkdir(path.join(f.root,'src'));await fs.writeFile(path.join(f.root,'src/AGENTS.md'),'Scoped instructions');await fs.mkdir(path.join(f.root,'node_modules'));await fs.writeFile(path.join(f.root,'node_modules/AGENTS.md'),'Not a project rule');await fs.symlink(f.home,path.join(f.root,'linked'));await fs.mkdir(path.join(f.root,'.opencode/agents'));await fs.writeFile(path.join(f.root,'.opencode/agents/nc-review.md'),'Owned');
    const editor=f.editor(),inventory=await editor.inventory();expect(inventory.files.map(file=>file.path)).toContain('src/AGENTS.md');expect(inventory.files.map(file=>file.path)).not.toContain('node_modules/AGENTS.md');expect(inventory.files.map(file=>file.path)).not.toContain('opencode-rag.json');expect(inventory.files.find(file=>file.path.endsWith('nc-review.md'))?.readonly).toBe(true);
    const opened=await editor.read('AGENTS.md'),preview=await editor.prepare({path:'AGENTS.md',revision:opened.revision,text:'# Local\n'});await expect(fs.stat(path.join(f.root,'AGENTS.md'))).rejects.toHaveProperty('code','ENOENT');const result=await editor.save(preview);expect(result.saved).toBe(true);expect(await fs.readFile(path.join(f.root,'AGENTS.md'),'utf8')).toBe('# Local\n');expect((await fs.stat(path.join(f.root,'AGENTS.md'))).mode&0o777).toBe(0o600);
 });
 it('preserves JSONC comments, unknown fields, secrets and permissions; completed open-job context never enters the journal',async()=>{
    const f=await fixture(),relative='opencode.jsonc',raw='// local comment\n{"theme":"dark","manual":{"apiKey":"LOCAL_SECRET"}}\n';await fs.writeFile(path.join(f.root,relative),raw,{mode:0o640});await fs.chmod(path.join(f.root,relative),0o640);
    const editor=f.editor();await editor.inventory();const opened=await editor.read(relative),after=raw.replace('"dark"','"light"'),preview=await editor.prepare({path:relative,revision:opened.revision,text:after});
    const result=await jobContext.run({id:randomUUID(),lease:randomUUID()},()=>editor.save(preview));expect(await fs.readFile(path.join(f.root,relative),'utf8')).toBe(after);expect((await fs.stat(path.join(f.root,relative))).mode&0o777).toBe(0o640);
    const journal=parseJournal(await fs.readFile(result.recoveryPath,'utf8'),f.root);expect(journal.job).toBeUndefined();expect(journal.result).toBeUndefined();expect(await pendingCompletions()).toEqual([]);
 });
 it.each(['edit','same-bytes-inode','symlink'])('refuses a stale preview after %s without overwriting manual bytes',async change=>{
    const f=await fixture(),file=path.join(f.root,'AGENTS.md');await fs.writeFile(file,'Original');const editor=f.editor();await editor.inventory();const opened=await editor.read('AGENTS.md'),preview=await editor.prepare({path:'AGENTS.md',revision:opened.revision,text:'New'});
    if(change==='edit')await fs.writeFile(file,'Concurrent manual');if(change==='same-bytes-inode'){await fs.rename(file,file+'.old');await fs.writeFile(file,'Original');}if(change==='symlink'){await fs.writeFile(path.join(f.home,'outside'),'Outside');await fs.rm(file);await fs.symlink(path.join(f.home,'outside'),file);}
    await expect(editor.save(preview)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(change==='edit'?'Concurrent manual':change==='symlink'?'Outside':'Original');
 });
 it('fresh revocation before commit prevents mutation and permits a deliberate retry with the existing draft',async()=>{
    const f=await fixture();let allowed=true;const editor=f.editor(async()=>{if(!allowed)throw Error('REVOKED');});await editor.inventory();const opened=await editor.read('AGENTS.md'),preview=await editor.prepare({path:'AGENTS.md',revision:opened.revision,text:'Draft stays'});allowed=false;await expect(editor.save(preview)).rejects.toThrow('REVOKED');await expect(fs.stat(path.join(f.root,'AGENTS.md'))).rejects.toHaveProperty('code','ENOENT');allowed=true;expect((await editor.save(preview)).saved).toBe(true);
 });
 it('two editor sessions serialize and reject the stale writer',async()=>{
    const f=await fixture(),one=f.editor(),two=f.editor();await one.inventory();await two.inventory();const a=await one.read('AGENTS.md'),b=await two.read('AGENTS.md');const p1=await one.prepare({path:'AGENTS.md',revision:a.revision,text:'One'}),p2=await two.prepare({path:'AGENTS.md',revision:b.revision,text:'Two'});await one.save(p1);await expect(two.save(p2)).rejects.toThrow();expect(await fs.readFile(path.join(f.root,'AGENTS.md'),'utf8')).toBe('One');
 });
 it('reserves canonical agent files and connection keys, while unrelated manual settings remain editable',async()=>{
    const f=await fixture();await fs.mkdir(path.join(f.root,'.opencode/agents'));await fs.writeFile(path.join(f.root,'.opencode/agents/nc-review.md'),'Canonical');await fs.writeFile(path.join(f.root,'opencode.jsonc'),'{"agent":{"nc-review":{"prompt":"site"}},"theme":"dark"}');
    const editor=f.editor();await editor.inventory();let opened=await editor.read('.opencode/agents/nc-review.md');await expect(editor.prepare({path:opened.file.path,revision:opened.revision,text:'Manual'})).rejects.toThrow('принадлежит');opened=await editor.read('opencode.jsonc');await expect(editor.prepare({path:opened.file.path,revision:opened.revision,text:'{"agent":{},"theme":"dark"}'})).rejects.toThrow('Управляемые');expect((await editor.prepare({path:opened.file.path,revision:opened.revision,text:opened.content.replace('dark','light')})).changed).toBe(true);
 });
 it('adds the explicit verified agent section and preserves every byte outside its markers',async()=>{
    const f=await fixture(),relative=agentFile('nc-review'),text='---\nname: nc-review\n---\nPROMPT_MUST_NOT_ENTER_AGENTS',receipt=JSON.stringify({schemaVersion:1,projectId:f.descriptor.projectId,bindingId:f.descriptor.bindingId,instanceId:f.descriptor.instanceId,revision:1,manifestSha256:'a'.repeat(64),agents:[{id:'review',slug:'nc-review',version:1,enabled:true,sha256:hash(text)}]});
    await fs.mkdir(path.dirname(path.join(f.root,relative)),{recursive:true});await fs.writeFile(path.join(f.root,relative),text);
    await jobContext.exit(()=>commitChanges(f.root,[{relative:AGENTS_RECEIPT,before:null,after:receipt}],{action:'install',assetKey:agentsJournalKey(f.descriptor.projectId),manifest:'a'.repeat(64),result:{projectId:f.descriptor.projectId}}));
    const before='Manual preface\r\n\r\n<!-- neurocenter:agents:start -->\r\nOld body\r\n<!-- neurocenter:agents:end -->\r\nManual footer\r\n';await fs.writeFile(path.join(f.root,'AGENTS.md'),before);const editor=f.editor();await editor.inventory();const opened=await editor.read('AGENTS.md'),preview=await editor.prepare({path:'AGENTS.md',revision:opened.revision,agentSection:true,draft:before.replace('Manual preface','Edited preface')});
    expect(preview.after).toContain('Edited preface\r\n\r\n<!--');expect(preview.after).toContain('<!-- neurocenter:agents:end -->\r\nManual footer\r\n');expect(preview.after).toContain('`nc-review`');expect(preview.after).not.toContain('PROMPT_MUST_NOT');expect(await fs.readFile(path.join(f.root,'AGENTS.md'),'utf8')).toBe(before);
 });
 it('rejects forged RAG ownership, escaped paths, unknown revisions and malformed JSON before a write',async()=>{
    const f=await fixture(),editor=f.editor();await editor.inventory();await expect(editor.read('../outside')).rejects.toThrow('Выберите');const opened=await editor.read('opencode.jsonc');await expect(editor.prepare({path:opened.file.path,revision:opened.revision,text:'{"duplicate":1,"duplicate":2}'})).rejects.toThrow('повторяющихся');await expect(editor.prepare({path:opened.file.path,revision:'bad',text:'{}'})).rejects.toThrow('изменились');f.context.descriptor.ragInstallations=[{kind:'mcp',id:'forged',version:1,manifest:'b'.repeat(64)}];await expect(editor.inventory()).rejects.toThrow('не подтверждена');
 });
 it('opens installed RAG only with its exact ledger and private receipt, applies friendly fields, and protects the server model',async()=>{
    const f=await fixture(),key=hash('mcp:rag-fixture').slice(0,24),ref={kind:'mcp' as const,id:'rag-fixture',version:1,manifest:'e'.repeat(64)},receipt=JSON.stringify({version:1,manifest:ref.manifest,files:{}}),relative='.opencode/neurocenter/receipts/'+key+'.json';f.context.descriptor.ragInstallations=[ref];
    const member={key,...ref},ledger=JSON.stringify({schemaVersion:1,roots:{[key]:{root:member,manifest:ref.manifest,packages:[member]}}});
    await jobContext.exit(()=>commitChanges(f.root,[{relative,before:null,after:receipt},{relative:'.opencode/neurocenter/installations.json',before:null,after:ledger}],{action:'install',assetKey:key,manifest:ref.manifest,result:{projectId:f.descriptor.projectId,bindingId:f.descriptor.bindingId,assetId:ref.id,version:1,manifest:ref.manifest}}));
    await fs.writeFile(path.join(f.root,'opencode-rag.json'),'{"embedding":{"model":"server-owned"},"custom":true}');await writePrivateConfiguration(profileKey(f.context.site,f.root,f.descriptor.instanceId),{fixture:true},undefined);
    const editor=f.editor(),inventory=await editor.inventory();expect(inventory.ragAvailable).toBe(true);const opened=await editor.read('opencode-rag.json');expect(opened.managedProfile).toBe(true);const preview=await editor.prepare({path:'opencode-rag.json',revision:opened.revision,rag:{topK:9}});expect(JSON.parse(preview.after).custom).toBe(true);await editor.save(preview);expect(JSON.parse(await fs.readFile(path.join(f.root,'opencode-rag.json'),'utf8')).retrieval.topK).toBe(9);
    const second=await editor.read('opencode-rag.json');await expect(editor.prepare({path:second.file.path,revision:second.revision,text:second.content.replace('server-owned','manual-change')})).rejects.toThrow('управляются');
 });
 it('friendly RAG edits preserve unknown fields; managed embedding changes are rejected',()=>{
    const raw='{"embedding":{"model":"manual"},"retrieval":{"topK":10,"custom":true},"unknown":{"keep":1}}\n',updated=updateRagFields(raw,{topK:7,minScore:0.5,excludeDirs:['node_modules'],includeExtensions:['.ts']});expect(configurationObject(updated,true)).toMatchObject({embedding:{model:'manual'},retrieval:{topK:7,custom:true,minScore:0.5},unknown:{keep:1}});expect(ragFields(configurationObject(updated,true)).topK).toBe(7);expect(()=>updateRagFields(raw,{minScore:2})).toThrow('оценка');expect(()=>preserveRagProfile(configurationObject(raw),{embedding:{model:'changed'}},true)).toThrow('управляются');expect(()=>preserveRagProfile(configurationObject(raw),{embedding:{model:'changed'}},false)).not.toThrow();
 });
 it('rolls back a filesystem failure and does not create a false committed receipt',async()=>{
    const f=await fixture(),editor=f.editor();await editor.inventory();const opened=await editor.read('AGENTS.md'),preview=await editor.prepare({path:'AGENTS.md',revision:opened.revision,text:'New'}),original=fs.link.bind(fs);let failed=false;
    vi.spyOn(fs,'link').mockImplementation(async(from,to)=>{if(!failed&&to===path.join(f.root,'AGENTS.md')){failed=true;throw Error('synthetic disk failure');}return original(from,to);});await expect(editor.save(preview)).rejects.toThrow('synthetic');await expect(fs.stat(path.join(f.root,'AGENTS.md'))).rejects.toHaveProperty('code','ENOENT');const directory=journalDirectory(f.root),names=await fs.readdir(path.join(directory,'history'));expect(names.length).toBe(1);expect(parseJournal(await fs.readFile(path.join(directory,'history',names[0]!),'utf8'),f.root).state).toBe('rolled-back');
 });
});
