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
 it('Prepared adapter has one explicit adapter entrypoint and accepts its exact submit',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockImplementation(async()=>Response.json({name:'opencode-snip',version:'2.0.0',main:'index.js'})));
  expect(await resolveNpmSource('opencode-snip')).toMatchObject({entrypoint:'entrypoint.mjs',candidates:['entrypoint.mjs'],runnableKinds:['plugin'],requiresEntrypointChoice:false});
  expect(await resolveNpmSource('opencode-snip@2.0.0','entrypoint.mjs')).toMatchObject({recommendedKind:'plugin'});
 });
});
