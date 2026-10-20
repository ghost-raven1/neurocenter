import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {opencodeModelCandidates,readOpenCodeModelMetadata} from '../src/bridge/opencode-model-scan.js';
import {modelScanDigest,validModelScan} from '../../../services/shared/opencode-model-scan.cjs';
const context={projectId:'prj-test',bindingId:'a'.repeat(64),instanceId:randomUUID()};
const secret='DO_NOT_EXPORT_SECRET';
const provider=(baseURL='http://127.0.0.1:9999/v1')=>({provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL,apiKey:secret},models:{'model-v1':{name:'Team model'}}}}});
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
async function fixture(){const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-model-scan-')));directories.push(home);const root=path.join(home,'project');await fs.mkdir(root);await fs.mkdir(path.join(home,'.config/opencode'),{recursive:true});return {home,root,environment:{XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share')}};}
describe('Чтение OpenCode передаёт только metadata',()=>{
 it('JSONC и deep merge не раскрывают inline/auth/env/file keys',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),JSON.stringify(provider()));
  await fs.writeFile(path.join(f.root,'opencode.jsonc'),'// project\n'+JSON.stringify({provider:{team:{models:{'model-v2':{name:'Project model',modalities:{input:['text','image']}}},options:{apiKey:'{file:~/.secret}'}}}}));
  await fs.mkdir(path.join(f.home,'.local/share/opencode'),{recursive:true});await fs.writeFile(path.join(f.home,'.local/share/opencode/auth.json'),JSON.stringify({team:{type:'api',key:secret}}));
  const scan=await readOpenCodeModelMetadata(f.root,context,f);
  expect(scan.candidates).toHaveLength(2);expect(scan.candidates[1]).toMatchObject({model:'model-v2',capability:'vision',hasKey:true,credentialSource:'file',baseUrl:'http://127.0.0.1:9999/v1'});
  expect(JSON.stringify(scan)).not.toContain(secret);expect(JSON.stringify(scan)).not.toContain('~/.secret');expect(scan.warnings).toContain('file-reference-not-expanded');expect(validModelScan(scan,context)).toBe(true);
 });
 it('Выбранная builtin модель определяется без fetch models.dev и без переноса auth',()=>{
  const candidates=opencodeModelCandidates({model:'openai/gpt-fixture',small_model:'anthropic/claude-fixture'},{openai:{key:secret}});
  expect(candidates).toHaveLength(2);expect(candidates[0]).toMatchObject({provider:'openai',baseUrl:'https://api.openai.com/v1',hasKey:true});expect(candidates[1].blocker).toBe('unsupported-provider');expect(JSON.stringify(candidates)).not.toContain(secret);
 });
 it.each(['https://user:secret@example.test/v1','https://example.test/v1?key=secret','http://169.254.169.254','{env:PRIVATE_URL}','{file:/private/secret}'])('URL не раскрывает auth/reference: %s',url=>{
  const candidate=opencodeModelCandidates(provider(url))[0];expect(candidate.baseUrl).toBeNull();expect(candidate.blocker).toBeTruthy();
 });
 it('Отключённый provider не импортируется молча',()=>{expect(opencodeModelCandidates({...provider(),disabled_providers:['team']})[0].blocker).toBe('disabled-provider');});
 it.each(['invalid-json','duplicate-keys','symlink','ambiguous'])('Проблема %s запрещает частичный список',async problem=>{
  const f=await fixture();await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),JSON.stringify(provider()));const file=path.join(f.root,'opencode.json');
  if(problem==='invalid-json')await fs.writeFile(file,'{"provider":');
  if(problem==='duplicate-keys')await fs.writeFile(file,'{"provider":{},"provider":{}}');
  if(problem==='symlink')await fs.symlink(path.join(f.home,'.config/opencode/opencode.json'),file);
  if(problem==='ambiguous'){await fs.writeFile(file,'{}');await fs.writeFile(path.join(f.root,'opencode.jsonc'),'{}');}
  const scan=await readOpenCodeModelMetadata(f.root,context,f);expect(scan.candidates).toEqual([]);expect(scan.warnings).toContain(problem==='symlink'?'unsafe-path':problem==='ambiguous'?'ambiguous-config':'invalid-json');
 });
 it('Отзыв owner прерывает чтение, секретные поля и чужая папка не проходят server contract',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(provider()));
  await expect(readOpenCodeModelMetadata(f.root,context,{...f,authorize:vi.fn().mockRejectedValue(Error('Role revoked'))})).rejects.toThrow('Role revoked');
  const scan=await readOpenCodeModelMetadata(f.root,context,f);const changed={...scan,candidates:scan.candidates.map(candidate=>({...candidate,apiKey:secret}))};changed.digest=modelScanDigest(changed);
  expect(validModelScan(changed,context)).toBe(false);expect(validModelScan(scan,{...context,instanceId:randomUUID()})).toBe(false);
 });
});
