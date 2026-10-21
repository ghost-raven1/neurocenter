import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {migrateCatalog,migrationChecksum} from '../src/database/migrations';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';

describe('Security events belong to the canonical catalog migration transaction',()=>{
 it('the first baseline owns platform users and shared audit, before any versioned dependent tables',async()=>{
  const query=vi.fn(async()=>({rows:[]})),release=vi.fn();
  await migrateCatalog({connect:async()=>({query,release})} as unknown as Pool,[CATALOG_MIGRATIONS[0]]);
  expect(query.mock.calls.map(call=>call[0])).toEqual(['BEGIN',expect.stringContaining('neurocenter:catalog:migrations'),expect.stringContaining('catalog_schema_migrations'),'SELECT version,name,checksum FROM catalog_schema_migrations ORDER BY version',CATALOG_MIGRATIONS[0].sql,expect.stringContaining('INSERT INTO catalog_schema_migrations'),'COMMIT']);
  expect(CATALOG_MIGRATIONS[0].sql).toContain('CREATE TABLE IF NOT EXISTS security_events');
  expect(CATALOG_MIGRATIONS[0].sql).toContain('CREATE TABLE IF NOT EXISTS platform_users');
  expect(query.mock.calls[5][1]).toEqual([0,CATALOG_MIGRATIONS[0].name,migrationChecksum(CATALOG_MIGRATIONS[0].sql)]);
  expect(release).toHaveBeenCalledOnce();
 });
 it('DDL failure never records baseline and releases its borrowed connection',async()=>{
  const failure=Error('DDL failed'),release=vi.fn(),query=vi.fn(async(sql:string)=>{if(sql===CATALOG_MIGRATIONS[0].sql)throw failure;return {rows:[]};});
  await expect(migrateCatalog({connect:async()=>({query,release})} as unknown as Pool,[CATALOG_MIGRATIONS[0]])).rejects.toBe(failure);
  expect(query.mock.calls.at(-1)).toEqual(['ROLLBACK']);expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);expect(release).toHaveBeenCalledOnce();
 });
});
