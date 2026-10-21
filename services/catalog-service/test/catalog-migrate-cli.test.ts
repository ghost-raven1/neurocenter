import {afterAll,afterEach,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrationChecksum} from '../src/database/migrations';
const exec=promisify(execFile),require=createRequire(import.meta.url),connection=process.env.CATALOG_TEST_PG_URL;
let directory:string,runner:string;
const created:Array<{name:string;admin:Pool;pool:Pool}>=[];
beforeAll(async()=>{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'nc-catalog-cli-'));runner=path.join(directory,'runner.cjs');
 await fs.writeFile(runner,`const fs=require('node:fs'),ts=require(${JSON.stringify(require.resolve('typescript'))});require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021,esModuleInterop:true}}).outputText,f);require(${JSON.stringify(path.resolve('src/database/migrate.cli.ts'))});`);
});
afterEach(async()=>{for(const {pool,admin,name} of created.splice(0)){await pool.end();await admin.query('DROP DATABASE '+name);await admin.end();}});
afterAll(async()=>{await fs.rm(directory,{recursive:true,force:true});});
const call=(args:string[],extra:NodeJS.ProcessEnv={})=>exec(process.execPath,[runner,...args],{env:{PATH:process.env.PATH,HOME:directory,NODE_ENV:'test',...extra},timeout:15000,maxBuffer:1024*1024});
async function database(){const url=new URL(connection!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Only disposable localhost databases');url.pathname='/postgres';const admin=new Pool({connectionString:url.href,max:1}),name='nc_catalog_cli_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);url.pathname='/'+name;const pool=new Pool({connectionString:url.href,max:1});created.push({pool,admin,name});return{pool,url:url.href};}
describe('Canonical migration CLI — actual child Node process',()=>{
 it('manifest is offline, ignores missing secret files and emits only exact version/name/SHA',async()=>{
  const result=await call(['manifest'],{NODE_ENV:'production',CATALOG_PG_URL:'postgresql://unreachable.invalid/fixture',CATALOG_PG_URL_FILE:'/absent/private/secret'});
  expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toEqual(CATALOG_MIGRATIONS.map(({version,name,sql})=>({version,name,checksum:migrationChecksum(sql)})));
 });
 it.each([[],['unknown'],['manifest','extra'],['migrate','--ready'],['check','--unknown'],['check','--ready','--ready']].map(args=>({args})))('invalid command $args fails without DB or private values',async ({args})=>{
  const result=await call(args,{CATALOG_PG_URL:'private-connection-marker'}).then(()=>null,error=>error);expect(result).not.toBeNull();expect(result.code).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).not.toContain('private-connection-marker');
 });
 it('missing secret file fails safely without printing its path',async()=>{
  const result=await call(['check'],{CATALOG_PG_URL_FILE:'/missing/private/fixture-marker'}).then(()=>null,error=>error);expect(result.code).toBe(1);expect(result.stderr).not.toContain('fixture-marker');expect(result.stdout).toBe('');
 });
 it.skipIf(!connection)('check permits pending without writes; --ready rejects it; migrate commits before reporting ready',async()=>{
  const db=await database(),env={CATALOG_PG_URL:db.url};const before=await call(['check'],env);expect(JSON.parse(before.stdout)).toEqual({ok:true,ready:false,existingSchema:false,applied:[],pending:[0,1,2,3,4,5,6]});
  expect((await db.pool.query("SELECT to_regclass('catalog_schema_migrations') AS name")).rows[0].name).toBeNull();
  expect((await call(['check','--ready'],env).then(()=>null,e=>e)).code).toBe(1);
  const migrated=await call(['migrate'],env);expect(JSON.parse(migrated.stdout)).toEqual({ok:true,ready:true,existingSchema:true,applied:[0,1,2,3,4,5,6],pending:[]});
  expect(JSON.parse((await call(['check','--ready'],env)).stdout).ready).toBe(true);
  await db.pool.query("UPDATE catalog_schema_migrations SET checksum='corrupt' WHERE version=3");expect((await call(['migrate'],env).then(()=>null,e=>e)).code).toBe(1);expect((await db.pool.query('SELECT count(*) FROM catalog_schema_migrations')).rows[0].count).toBe('7');
 });
});
