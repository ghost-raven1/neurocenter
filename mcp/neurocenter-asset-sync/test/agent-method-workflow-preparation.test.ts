import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {methodFixture} from './agent-method-workflow.fixture.js';
import {prepareMethod,methodEnvironment} from '../src/features/agent-method-workflow/preparation.js';
import type {MethodCommandRunner} from '../src/features/agent-method-workflow/process.js';

describe('Real method preparation boundaries without model dispatch',()=>{
 let fixture:Awaited<ReturnType<typeof methodFixture>>;
 const run:MethodCommandRunner=async(command,args)=>({code:0,signal:null,stdout:args[0]==='--version'?command==='openspec'?'1.15.0\n':command==='bmad'?'6.12.4\n':'1.14.48\n':JSON.stringify({root:{path:fixture.root}})});
 beforeEach(async()=>{fixture=await methodFixture();});
 afterEach(async()=>{vi.unstubAllEnvs();await fs.rm(fixture.temporary,{recursive:true,force:true});});
 const skill=async(name:string)=>{const directory=path.join(fixture.root,'.opencode/skills',name);await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'SKILL.md'),'OFFICIAL_PROJECT_WORKFLOW_'+name);};
 it('loads actual installed project workflow files and verifies CLI context/list before preparing the coding command',async()=>{
  await fs.mkdir(path.join(fixture.root,'openspec'));await fs.writeFile(path.join(fixture.root,'openspec/config.yaml'),'schema: spec-driven\n');
  for(const name of ['openspec-propose','openspec-apply-change','openspec-verify-change','openspec-archive-change'])await skill(name);
  const reads=vi.fn(run),prepared=await prepareMethod(fixture.root,fixture.payload,reads);
  expect(reads.mock.calls.map(([,args])=>args)).toContainEqual(['context','--json']);expect(reads.mock.calls.map(([,args])=>args)).toContainEqual(['list','--json']);
  expect(prepared.command).toBe(process.execPath);expect(prepared.args).toEqual([expect.stringMatching(/opencode-http-runner\.(?:ts|js)$/),'--agent-method-runtime',expect.any(String),fixture.root,expect.stringContaining('OFFICIAL_PROJECT_WORKFLOW_openspec-apply-change')]);
  expect(prepared.outputProtocol).toBe('opencode-http-v1');
  expect(prepared.args.at(-1)).toContain(fixture.payload.instruction);expect(prepared.validate?.args).toEqual(['validate','--all','--strict','--no-interactive']);
  expect(methodEnvironment().OPENCODE_PERMISSION).toBe('{"external_directory":"deny"}');expect(reads.mock.calls.some(([,args])=>args[0]==='run')).toBe(false);
 });
 it('requires the pinned BMAD manifest and real build/review workflow files',async()=>{
  const directory=path.join(fixture.root,'_bmad/_config');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'manifest.yaml'),'installation:\n  version: 6.12.4\n');
  await fs.mkdir(path.join(fixture.root,'_bmad/scripts'));await fs.writeFile(path.join(fixture.root,'_bmad/scripts/render_skill.py'),'# owned renderer fixture\n');
  for(const name of ['bmad-help','bmad-spec','bmad-build-auto','bmad-code-review'])await skill(name);
  const prepared=await prepareMethod(fixture.root,{...fixture.payload,method:'bmad',methodVersion:'6.12.4'},run);expect(prepared.args.at(-1)).toContain('OFFICIAL_PROJECT_WORKFLOW_bmad-build-auto');
 });
 it('reports an old runtime, missing project root and missing official workflows separately',async()=>{
  await expect(prepareMethod(fixture.root,fixture.payload,async()=>({code:0,signal:null,stdout:'1.3.2\n'}))).rejects.toMatchObject({code:'RUNTIME_MISSING'});
  await expect(prepareMethod(fixture.root,fixture.payload,run)).rejects.toMatchObject({code:'PROJECT_NOT_INITIALIZED'});
  await fs.mkdir(path.join(fixture.root,'openspec'));await fs.writeFile(path.join(fixture.root,'openspec/config.yaml'),'schema: spec-driven\n');
  await expect(prepareMethod(fixture.root,fixture.payload,run)).rejects.toMatchObject({code:'METHOD_WORKFLOW_MISSING'});
 });
 it('requires explicit check commands before any CLI observation or runtime execution',async()=>{
  const observe=vi.fn(run);await expect(prepareMethod(fixture.root,{...fixture.payload,checks:[]},observe)).rejects.toMatchObject({code:'CHECKS_REQUIRED'});expect(observe).not.toHaveBeenCalled();
 });
 it('preserves configured inline providers/model and restrictive permissions while denying external directories',()=>{
  vi.stubEnv('OPENCODE_CONFIG_CONTENT',JSON.stringify({model:'owned/model',provider:{owned:{options:{baseURL:'http://127.0.0.1:1234'}}},permission:{bash:'deny'}}));
  vi.stubEnv('OPENCODE_PERMISSION',JSON.stringify({edit:'deny'}));const env=methodEnvironment();
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({model:'owned/model',provider:{owned:{options:{baseURL:'http://127.0.0.1:1234'}}},permission:{bash:'deny',external_directory:'deny'}});
  expect(JSON.parse(env.OPENCODE_PERMISSION!)).toEqual({edit:'deny',external_directory:'deny'});
 });
 it('combines BMAD planning and one OpenSpec implementation cycle, treating Quirk as optional untrusted context',async()=>{
  await fs.mkdir(path.join(fixture.root,'_bmad/_config'),{recursive:true});await fs.writeFile(path.join(fixture.root,'_bmad/_config/manifest.yaml'),'installation:\n  version: 6.12.4\n');
  await fs.mkdir(path.join(fixture.root,'_bmad/scripts'));await fs.writeFile(path.join(fixture.root,'_bmad/scripts/render_skill.py'),'# owned renderer\n');
  await fs.mkdir(path.join(fixture.root,'openspec'));await fs.writeFile(path.join(fixture.root,'openspec/config.yaml'),'schema: spec-driven\n');
  for(const name of ['bmad-help','bmad-product-brief','bmad-prd','bmad-architecture','openspec-propose','openspec-apply-change','openspec-verify-change','openspec-archive-change'])await skill(name);
  const reads=vi.fn(run),prepared=await prepareMethod(fixture.root,{...fixture.payload,method:'combined',methodVersion:'bmad-6.12.4+openspec-1.15.0'},reads),prompt=prepared.args.at(-1)!;
  expect(reads.mock.calls.some(([command,args])=>command==='bmad'&&args[0]==='--version')).toBe(true);expect(reads.mock.calls.some(([command,args])=>command==='openspec'&&args[0]==='--version')).toBe(true);
  expect(prompt).toContain('OFFICIAL_PROJECT_WORKFLOW_bmad-prd');expect(prompt).toContain('OFFICIAL_PROJECT_WORKFLOW_openspec-apply-change');expect(prompt).not.toContain('OFFICIAL_PROJECT_WORKFLOW_bmad-build-auto');expect(prompt).toContain('Do not repair, delete, replace or reindex their baseline');
 });
});
