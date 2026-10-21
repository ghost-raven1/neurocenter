import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(path.join(root,'services/catalog-service/package.json'));
require('ts-node').register({project:path.join(root,'services/catalog-service/tsconfig.json'),transpileOnly:true});
const ts=require('typescript');
const {CATALOG_MIGRATIONS}=require(path.join(root,'services/catalog-service/src/database/catalog-migrations.ts'));
const {FEATURE_FLAGS_MIGRATIONS}=require(path.join(root,'services/feature-flags-service/src/database/migrations.ts'));
const {RAG_MIGRATIONS}=require(path.join(root,'services/rag-sync-service/src/database/migration-definitions.ts'));
const {RAG_QUOTA_SCHEMA}=require(path.join(root,'services/rag-sync-service/src/rag/quota/rag-quota-schema.ts'));
const sources=['services/catalog-service/src','services/feature-flags-service/src','services/rag-sync-service/src','services/shared'];
const journals=new Map([
    ['catalog_schema_migrations','services/catalog-service/src/database/migrations.ts'],
    ['feature_flags_schema_migrations','services/feature-flags-service/src/database/migrations.ts'],
    ['neurocenter_rag_schema_versions','services/rag-sync-service/src/database/migrations.ts'],
    ['neurocenter_rag_migrations','services/rag-sync-service/src/rag/quota/rag-quota.ts'],
]);
const tableNames=sql=>[...sql.matchAll(/\bCREATE\s+(?:UNLOGGED\s+|TEMPORARY\s+|TEMP\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?([a-z_]\w*)/gi)].map(match=>match[1].toLowerCase());
function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);return entry.isDirectory()?files(file):/\.(?:ts|cjs)$/.test(file)&&!file.endsWith('.d.cts')?[file]:[];
});}

/** Resolve the actual static SQL import graph; new schema modules require registration, not a hand-maintained allowlist. */
function schemaGraph(entries,visited=new Set()){
    for(const entry of entries){
        const file=path.resolve(root,entry);if(visited.has(file))continue;visited.add(file);
        const source=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
        for(const statement of source.statements){
            if(!(ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))||!statement.moduleSpecifier||!ts.isStringLiteral(statement.moduleSpecifier))continue;
            const target=statement.moduleSpecifier.text;if(!target.startsWith('.'))continue;
            const base=path.resolve(path.dirname(file),target),dependency=[base,base+'.ts',base+'.cjs',path.join(base,'index.ts')].find(candidate=>fs.existsSync(candidate)&&fs.statSync(candidate).isFile());
            if(dependency)schemaGraph([dependency],visited);
        }
    }
    return visited;
}
const graph=schemaGraph(['services/catalog-service/src/database/catalog-migrations.ts','services/feature-flags-service/src/database/migrations.ts',
    'services/rag-sync-service/src/database/migration-definitions.ts']);
const statements=[...CATALOG_MIGRATIONS.map(row=>row.sql),...FEATURE_FLAGS_MIGRATIONS.map(row=>row.sql),...RAG_MIGRATIONS.map(row=>row.sql),RAG_QUOTA_SCHEMA];
const registered=new Set(statements.flatMap(tableNames));
const definitions=sources.flatMap(directory=>files(path.join(root,directory))).flatMap(file=>tableNames(fs.readFileSync(file,'utf8')).map(table=>({table,file:path.relative(root,file)})));

test('Every PostgreSQL application table belongs to registered migration SQL',()=>{
    const missing=definitions.filter(({table,file})=>!registered.has(table)&&journals.get(table)!==file);
    assert.deepEqual(missing,[],'Unversioned table creators must move into a numbered migration');
    for(const table of registered)assert.ok(definitions.some(row=>row.table===table),'Registered table has no source owner: '+table);
});

test('Services and repositories cannot retain independent application table DDL',()=>{
    const runtime=definitions.filter(({table,file})=>journals.get(table)!==file&&!graph.has(path.join(root,file)));
    assert.deepEqual(runtime,[],'CREATE TABLE remains outside the registered SQL dependency graph');
});
