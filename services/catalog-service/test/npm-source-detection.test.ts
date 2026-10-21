import {afterEach,describe,expect,it,vi} from 'vitest';
import {resolveNpmSource} from '../src/package-build/npm-source';
describe('Executable npm evidence',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it('Two real bin commands require explicit choice; main library is not an extra executable',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({name:'tool',version:'1.0.0',bin:{first:'bin/one.js',second:'bin/two.js'},main:'dist/library.js'})));
  const metadata=await resolveNpmSource('tool');expect(metadata).toMatchObject({entrypoint:'',requiresEntrypointChoice:true,candidates:['bin/one.js','bin/two.js'],runnableKinds:['mcp']});
  expect(await resolveNpmSource('tool@1.0.0','bin/two.js')).toMatchObject({entrypoint:'bin/two.js',requiresEntrypointChoice:false});
  await expect(resolveNpmSource('tool@1.0.0','dist/library.js')).rejects.toThrow('из списка');
 });
 it('A library entry is shown for explanation but cannot be auto-classified as MCP',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'library',version:'1.0.0',main:'index.js'})));
  expect(await resolveNpmSource('library')).toMatchObject({runnableKinds:[],warnings:[expect.stringContaining('библиотека')]});
 });
 it('Node conditional exports are one logical plugin entrypoint',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'plugin',version:'1.0.0',dependencies:{'@opencode-ai/plugin':'1.0.0'},exports:{'.':{types:'./index.d.ts',node:{import:'./index.mjs',require:'./index.cjs'}}}})));
  expect(await resolveNpmSource('plugin')).toMatchObject({entrypoint:'index.mjs',candidates:['index.mjs'],runnableKinds:['plugin'],recommendedKind:'plugin'});
 });
 it.each(['dependencies','peerDependencies','devDependencies'])('A plugin export wins over its installer CLI declared through %s',async dependencyField=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({name:'plugin-with-cli',version:'1.0.0',
   bin:{install:'bin/install.js',alias:'bin/install.js'},main:'dist/legacy.js',
   exports:{'.':{types:'./dist/index.d.ts',import:'./dist/index.js'}},[dependencyField]:{'@opencode-ai/plugin':'1.0.0'}})));
  expect(await resolveNpmSource('plugin-with-cli')).toMatchObject({entrypoint:'dist/index.js',candidates:['dist/index.js'],
   runnableKinds:['plugin'],recommendedKind:'plugin',requiresEntrypointChoice:false});
  await expect(resolveNpmSource('plugin-with-cli@1.0.0','bin/install.js')).rejects.toThrow('из списка');
 });
 it('The published opencode-see-image package selects its plugin export automatically',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({name:'opencode-see-image',version:'1.4.0',
   main:'./dist/index.js',exports:{'.':'./dist/index.js'},dependencies:{'@opencode-ai/plugin':'^1.15.0','opencode-plugin-update-kit':'0.6.0'}})));
  expect(await resolveNpmSource('opencode-see-image@1.4.0')).toMatchObject({entrypoint:'dist/index.js',
   candidates:['dist/index.js'],runnableKinds:['plugin'],recommendedKind:'plugin',requiresEntrypointChoice:false});
 });
 it('Prepared adapter has one explicit adapter entrypoint and accepts its exact submit',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({name:'opencode-snip',version:'2.0.0',main:'index.js'})));
  expect(await resolveNpmSource('opencode-snip')).toMatchObject({entrypoint:'entrypoint.mjs',candidates:['entrypoint.mjs'],runnableKinds:['plugin'],requiresEntrypointChoice:false});
  expect(await resolveNpmSource('opencode-snip@2.0.0','entrypoint.mjs')).toMatchObject({recommendedKind:'plugin'});
 });
});
