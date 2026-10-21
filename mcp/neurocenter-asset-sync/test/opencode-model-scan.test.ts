import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {opencodeModelCandidates,readOpenCodeModelMetadata} from '../src/bridge/opencode-model-scan.js';
import {modelScanDigest,validModelScan} from '../../../services/shared/opencode-model-scan.cjs';
const context={scope:'project' as const,projectId:'prj-test',bindingId:'a'.repeat(64),instanceId:randomUUID()};
const secret='DO_NOT_EXPORT_SECRET';
const provider=(baseURL='http://127.0.0.1:9999/v1')=>({provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL,apiKey:secret},models:{'model-v1':{name:'Team model'}}}}});
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>fs.rm(dir,{recursive:true,force:true})));});
async function fixture(){const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-model-scan-')));directories.push(home);const root=path.join(home,'project');await fs.mkdir(root);await fs.mkdir(path.join(home,'.config/opencode'),{recursive:true});return {home,root,managedDirectory:path.join(home,'managed'),environment:{XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share')}};}
describe('Чтение OpenCode передаёт только metadata',()=>{
 it.each(['inline','environment','file','auth'])('Только opt-in разрешает чтение ключа %s в отдельный transient payload',async source=>{
  const f=await fixture(),config=provider();
  if(source==='environment')config.provider.team.options.apiKey='{env:QA_MODEL_KEY}';
  if(source==='file'){config.provider.team.options.apiKey='{file:./key.txt}';await fs.writeFile(path.join(f.root,'key.txt'),secret+'\n');}
  if(source==='auth'){
   delete (config.provider.team.options as {apiKey?:string}).apiKey;
   await fs.mkdir(path.join(f.home,'.local/share/opencode'),{recursive:true});await fs.writeFile(path.join(f.home,'.local/share/opencode/auth.json'),JSON.stringify({team:{type:'api',key:secret}}));
  }
  await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(config));
  const metadata=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,QA_MODEL_KEY:secret}});
  expect(JSON.stringify(metadata)).not.toContain(secret);
  const credentials:Record<string,string>={},scan=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,QA_MODEL_KEY:secret},credentialTarget:credentials});
  expect(Object.values(credentials)).toEqual([secret]);expect(JSON.stringify(scan)).not.toContain(secret);expect(scan).not.toHaveProperty('credentials');
 });
 it.each(['missing-env','missing-file','symlink-file','oauth','embedded-reference'])('Неподдерживаемый или недоступный credential %s не передаётся',async source=>{
  const f=await fixture(),config=provider();config.provider.team.options.apiKey=source==='embedded-reference'?'prefix-{env:QA_KEY}':source==='missing-env'?'{env:MISSING_KEY}':'{file:./key.txt}';
  if(source==='symlink-file'){await fs.writeFile(path.join(f.home,'outside-key'),secret);await fs.symlink(path.join(f.home,'outside-key'),path.join(f.root,'key.txt'));}
  if(source==='oauth'){
   delete (config.provider.team.options as {apiKey?:string}).apiKey;await fs.mkdir(path.join(f.home,'.local/share/opencode'),{recursive:true});
   await fs.writeFile(path.join(f.home,'.local/share/opencode/auth.json'),JSON.stringify({team:{type:'oauth',access:secret,refresh:secret}}));
  }
  await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(config));const credentials:Record<string,string>={};
  const scan=await readOpenCodeModelMetadata(f.root,context,{...f,credentialTarget:credentials});expect(credentials).toEqual({});expect(JSON.stringify(scan)).not.toContain(secret);
 });
 it('Env URL разворачивается локально, проходит тот же safe endpoint validation и не раскрывает имя переменной',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(provider('{env:QA_MODEL_URL}')));
  const scan=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,QA_MODEL_URL:'https://provider.example.test/v1'}});
  expect(scan.candidates[0]).toMatchObject({baseUrl:'https://provider.example.test/v1',blocker:null});expect(JSON.stringify(scan)).not.toContain('QA_MODEL_URL');
  const unsafe=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,QA_MODEL_URL:'https://user:secret@example.test/v1'}});
  expect(unsafe.candidates[0]).toMatchObject({baseUrl:null,blocker:'unsafe-endpoint'});
 });
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
 it.each(['invalid-json','duplicate-keys','symlink'])('Проблема %s запрещает частичный список',async problem=>{
  const f=await fixture();await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),JSON.stringify(provider()));const file=path.join(f.root,'opencode.json');
  if(problem==='invalid-json')await fs.writeFile(file,'{"provider":');
  if(problem==='duplicate-keys')await fs.writeFile(file,'{"provider":{},"provider":{}}');
  if(problem==='symlink')await fs.symlink(path.join(f.home,'.config/opencode/opencode.json'),file);
  const scan=await readOpenCodeModelMetadata(f.root,context,f);expect(scan.candidates).toEqual([]);expect(scan.warnings).toContain(problem==='symlink'?'unsafe-path':'invalid-json');
 });
 it('Отзыв owner прерывает чтение, секретные поля и чужая папка не проходят server contract',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(provider()));
  await expect(readOpenCodeModelMetadata(f.root,context,{...f,authorize:vi.fn().mockRejectedValue(Error('Role revoked'))})).rejects.toThrow('Role revoked');
  const scan=await readOpenCodeModelMetadata(f.root,context,f);const changed={...scan,candidates:scan.candidates.map(candidate=>({...candidate,apiKey:secret}))};changed.digest=modelScanDigest(changed);
  expect(validModelScan(changed,context)).toBe(false);expect(validModelScan(scan,{...context,instanceId:randomUUID()})).toBe(false);
 });
});
describe('Совместимость с metadata OpenCode 1.14.48',()=>{
 it('Global читает общие JSON/JSONC без проекта, игнорируя повреждённые project layers',async()=>{
  const f=await fixture(),source={scope:'global' as const,deviceId:randomUUID()};
  await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),JSON.stringify(provider('https://global.example.test/v1')));
  await fs.writeFile(path.join(f.home,'.config/opencode/opencode.jsonc'),JSON.stringify({provider:{team:{models:{'model-v1':{limit:{context:128000},options:{temperature:0.2}}}}}}));
  await fs.writeFile(path.join(f.root,'opencode.json'),'{invalid');await fs.mkdir(path.join(f.root,'.opencode'));await fs.writeFile(path.join(f.root,'.opencode/opencode.json'),'{invalid');
  const scan=await readOpenCodeModelMetadata(f.root,source,f);expect(scan).toMatchObject({schemaVersion:2,scope:'global',deviceId:source.deviceId});
  expect(scan).not.toHaveProperty('projectId');expect(scan.candidates[0]).toMatchObject({baseUrl:'https://global.example.test/v1',options:{temperature:0.2,contextWindow:128000}});
  expect(scan.warnings).not.toContain('invalid-json');expect(scan.warnings).not.toContain('ancestor-config-not-scanned');expect(validModelScan(scan,source)).toBe(true);
  expect(validModelScan(scan,{...source,deviceId:randomUUID()})).toBe(false);
  for(const patch of [{projectId:'fake-project'},{schemaVersion:1},{scope:'project'}]){
   const invalid={...scan,...patch};invalid.digest=modelScanDigest(invalid);expect(validModelScan(invalid,source)).toBe(false);
  }
 });
 it('Effective project сохраняет глобальные модели и накладывает свои параметры; global remains independent',async()=>{
  const f=await fixture();await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),JSON.stringify(provider()));
  await fs.writeFile(path.join(f.home,'.config/opencode/opencode.jsonc'),JSON.stringify({provider:{team:{models:{'model-v1':{limit:{context:128000},options:{temperature:0.1}},globalOnly:{}}}}}));
  await fs.writeFile(path.join(f.root,'opencode.jsonc'),JSON.stringify({provider:{team:{models:{'model-v1':{limit:{context:64000},options:{temperature:0.8}}}}}}));
  const project=await readOpenCodeModelMetadata(f.root,context,f),global=await readOpenCodeModelMetadata(f.home,{scope:'global',deviceId:randomUUID()},f);
  expect(project.candidates[0]!.options).toEqual({contextWindow:64000,temperature:0.8});expect(global.candidates[0]!.options).toEqual({contextWindow:128000,temperature:0.1});
  expect(project.candidates.map(item=>item.configKey)).toEqual(['model-v1','globalOnly']);
 });
 it('Читает родительские конфиги до ближайшей Git-границы с документированным порядком слоёв',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.root,'.git'));const nested=path.join(f.root,'nested');await fs.mkdir(nested);
  await fs.writeFile(path.join(f.home,'opencode.json'),'{invalid outside worktree');
  await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(provider('https://parent.example.test/v1')));
  await fs.writeFile(path.join(nested,'opencode.jsonc'),JSON.stringify({provider:{team:{models:{'model-v1':{name:'Nested model'}}}}}));
  let scan=await readOpenCodeModelMetadata(nested,context,f);expect(scan.candidates[0]).toMatchObject({name:'Nested model',baseUrl:'https://parent.example.test/v1'});expect(scan.warnings).not.toContain('ancestor-config-not-scanned');expect(scan.warnings).not.toContain('invalid-json');
  await fs.mkdir(path.join(f.root,'.opencode'));await fs.writeFile(path.join(f.root,'.opencode/opencode.json'),JSON.stringify({provider:{team:{models:{'model-v1':{name:'Parent dot config'}}}}}));
  scan=await readOpenCodeModelMetadata(nested,context,f);expect(scan.candidates[0]!.name).toBe('Parent dot config');
 });
 it('Импортирует upstream id, provider.api и числовые options без capability-limit и boolean temperature',()=>{
  const config={provider:{team:{npm:'@ai-sdk/openai-compatible',api:'https://example.test/v1/',options:{apiKey:secret,timeout:120000},models:{alias:{id:'upstream-model',name:'Visible name',temperature:true,limit:{context:128000,output:64000},options:{temperature:0,topP:1,maxOutputTokens:32768}}}}}};
  expect(opencodeModelCandidates(config)[0]).toMatchObject({name:'Visible name',model:'upstream-model',modelVersion:'upstream-model',baseUrl:'https://example.test/v1',options:{temperature:0,topP:1,maxOutputTokens:32768,contextWindow:128000},outputTokenLimit:64000,timeoutMs:120000,blocker:null});
  expect(JSON.stringify(opencodeModelCandidates(config))).not.toContain(secret);
  const plain=provider();plain.provider.team.models['model-v1']={name:'Plain',...{temperature:true,limit:{context:65536,output:4096}}};
  expect(opencodeModelCandidates(plain)[0]).toMatchObject({options:{contextWindow:65536},outputTokenLimit:4096});
 });
 it('baseURL имеет приоритет над provider.api и builtin адресом',()=>{
  const config={provider:{openai:{api:'https://api-fallback.test/v1',options:{baseURL:'https://chosen.test/v1'},models:{model:{}}}}};
  expect(opencodeModelCandidates(config)[0].baseUrl).toBe('https://chosen.test/v1');
  config.provider.openai.options.baseURL='';expect(opencodeModelCandidates(config)[0].baseUrl).toBe('https://api-fallback.test/v1');
 });
 it.each([
  {headers:{Authorization:secret}}, {options:{apiKey:secret}}, {options:{headers:{Authorization:secret}}}, {options:{temperature:'{env:SECRET}'}},
  {options:{temperature:-0.1}}, {options:{temperature:2.1}}, {options:{topP:1.1}}, {options:{maxOutputTokens:32769}}, {options:{maxOutputTokens:1.5}},
  {options:{reasoningEffort:'high'}}, {options:null}, {provider:{api:'https://override.test/v1'}}, {id:'https://example.test/secret'},
 ])('Параметры или headers, которые нельзя безопасно перенести, блокируются: %j',metadata=>{
  const config={provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://example.test/v1'},models:{alias:metadata}}}};
  const candidate=opencodeModelCandidates(config)[0];expect(candidate.blocker).toBe('unsupported-provider');expect(candidate).not.toHaveProperty('options');expect(JSON.stringify(candidate)).not.toContain(secret);
 });
 it.each([{headers:{Authorization:secret}},{timeout:false},{timeout:999},{timeout:300001},{timeout:1000.5},{extraBody:{key:secret}}])('Неподдерживаемые provider options блокируются: %j',options=>{
  const candidate=opencodeModelCandidates({provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://example.test/v1',...options},models:{alias:{}}}}})[0];
  expect(candidate.blocker).toBe('unsupported-provider');expect(candidate).not.toHaveProperty('timeoutMs');expect(JSON.stringify(candidate)).not.toContain(secret);
 });
 it('Учитывает whitelist/blacklist, deprecated и opt-in alpha, сохраняя enabled-provider blocker',()=>{
  const config={provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://example.test/v1'},whitelist:['allowed','denied','old','preview'],blacklist:['denied'],models:{allowed:{},denied:{},other:{},old:{status:'deprecated'},preview:{status:'alpha'}}}}};
  expect(opencodeModelCandidates(config).map(model=>model.model)).toEqual(['allowed']);
  expect(opencodeModelCandidates(config,{},true).map(model=>model.model)).toEqual(['allowed','preview']);
  expect(opencodeModelCandidates({...config,enabled_providers:['other']})[0].blocker).toBe('disabled-provider');
 });
 it('Фильтры OpenCode используют точный config alias, а не upstream id и не wildcard',()=>{
  const config={provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://example.test/v1'},whitelist:['alias'],blacklist:['upstream-model','ali*'],models:{alias:{id:'upstream-model'}}}}};
  expect(opencodeModelCandidates(config).map(model=>model.model)).toEqual(['upstream-model']);
  config.provider.team.whitelist=['upstream-model'];expect(opencodeModelCandidates(config)).toEqual([]);
  config.provider.team.whitelist=['ali*'];expect(opencodeModelCandidates(config)).toEqual([]);
 });
 it('Слои global config.json→json→jsonc→custom→project→.opencode→home→configdir→content→managed накладываются последовательно',async()=>{
  const f=await fixture();const layer=(name:string)=>JSON.stringify({provider:{team:{models:{'model-v1':{name}}}}});
  await fs.writeFile(path.join(f.home,'.config/opencode/config.json'),JSON.stringify(provider()));
  await fs.writeFile(path.join(f.home,'.config/opencode/opencode.json'),layer('global-json'));
  await fs.writeFile(path.join(f.home,'.config/opencode/opencode.jsonc'),'// JSONC wins\n'+layer('global-jsonc'));
  expect((await readOpenCodeModelMetadata(f.root,context,f)).candidates[0].name).toBe('global-jsonc');
  await fs.writeFile(path.join(f.root,'custom.json'),layer('custom'));const environment={...f.environment,OPENCODE_CONFIG:'custom.json'};
  expect((await readOpenCodeModelMetadata(f.root,context,{...f,environment})).candidates[0].name).toBe('custom');
  await fs.writeFile(path.join(f.root,'opencode.json'),layer('project-json'));
  await fs.writeFile(path.join(f.root,'opencode.jsonc'),layer('project-jsonc'));
  expect((await readOpenCodeModelMetadata(f.root,context,{...f,environment})).candidates[0].name).toBe('project-jsonc');
  for(const [directory,name]of [[path.join(f.root,'.opencode'),'local'],[path.join(f.home,'.opencode'),'home'],[path.join(f.root,'customdir'),'configdir']]){
   await fs.mkdir(directory!,{recursive:true});await fs.writeFile(path.join(directory!,'opencode.json'),layer(name!));
   const scan=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...environment,OPENCODE_CONFIG_DIR:'customdir'}});
   expect(scan.candidates[0].name).toBe(name);expect(scan.warnings).not.toContain('ambiguous-config');expect(validModelScan(scan,context)).toBe(true);
  }
  const content={...environment,OPENCODE_CONFIG_DIR:'customdir',OPENCODE_CONFIG_CONTENT:layer('content')};
  expect((await readOpenCodeModelMetadata(f.root,context,{...f,environment:content})).candidates[0].name).toBe('content');
  await fs.mkdir(f.managedDirectory);await fs.writeFile(path.join(f.managedDirectory,'opencode.json'),layer('managed-json'));
  await fs.writeFile(path.join(f.managedDirectory,'opencode.jsonc'),layer('managed-jsonc'));
  expect((await readOpenCodeModelMetadata(f.root,context,{...f,environment:content})).candidates[0].name).toBe('managed-jsonc');
 });
 it.each(['true','1','TRUE'])('Disable-project=%s не читает даже повреждённые project/.opencode файлы',async flag=>{
  const f=await fixture();await fs.writeFile(path.join(f.home,'.config/opencode/config.json'),JSON.stringify(provider()));
  await fs.writeFile(path.join(f.root,'opencode.json'),'{invalid');await fs.mkdir(path.join(f.root,'.opencode'));await fs.writeFile(path.join(f.root,'.opencode/opencode.json'),'{invalid');
  const scan=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,OPENCODE_DISABLE_PROJECT_CONFIG:flag}});
  expect(scan.candidates).toHaveLength(1);expect(scan.warnings).not.toContain('invalid-json');
 });
 it('Не изменяет файлы и не разворачивает env/file references в inline config',async()=>{
  const f=await fixture();const file=path.join(f.root,'opencode.jsonc'),source='// preserve me\n'+JSON.stringify(provider());await fs.writeFile(file,source);
  const scan=await readOpenCodeModelMetadata(f.root,context,{...f,environment:{...f.environment,OPENCODE_CONFIG_CONTENT:JSON.stringify({provider:{team:{options:{apiKey:'{env:PRIVATE_KEY}'}}}})}});
  expect(await fs.readFile(file,'utf8')).toBe(source);expect(scan.warnings).toContain('env-reference-not-expanded');expect(scan.candidates[0]).toMatchObject({hasKey:true,credentialSource:'environment'});expect(JSON.stringify(scan)).not.toContain('PRIVATE_KEY');
 });
 it('Добавочные числовые defaults проверяются серверным контрактом и входят в digest',async()=>{
  const f=await fixture();const config={provider:{team:{npm:'@ai-sdk/openai-compatible',options:{baseURL:'https://example.test/v1',timeout:1000},models:{alias:{options:{temperature:0.2,topP:0,maxOutputTokens:1}}}}}};
  await fs.writeFile(path.join(f.root,'opencode.json'),JSON.stringify(config));const scan=await readOpenCodeModelMetadata(f.root,context,f);expect(validModelScan(scan,context)).toBe(true);
  const tampered=structuredClone(scan);tampered.candidates[0].options!.temperature=0.7;expect(validModelScan(tampered,context)).toBe(false);
  for(const patch of [{options:{apiKey:secret}},{options:{temperature:'0.2'}},{options:{temperature:NaN}},{options:{maxOutputTokens:32769}},{timeoutMs:999},{timeoutMs:Infinity}]){
   const changed={...scan,candidates:scan.candidates.map(candidate=>({...candidate,...patch}))};changed.digest=modelScanDigest(changed);expect(validModelScan(changed,context)).toBe(false);
  }
  const older={...scan,candidates:scan.candidates.map(({options:_options,timeoutMs:_timeout,...candidate})=>candidate)};older.digest=modelScanDigest(older);expect(validModelScan(older,context)).toBe(true);
 });
});
