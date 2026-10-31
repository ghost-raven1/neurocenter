import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const root=fileURLToPath(new URL('../..',import.meta.url));
const packages=['api-gateway','catalog-service','feature-flags-service','oauth2-bridge','rag-sync-service','skills-service']
    .map(name=>'services/'+name).concat('mcp/neurocenter-asset-sync');

for(const directory of packages)test(`${directory}: installed lint contract`,async()=>{
    const cwd=path.join(root,directory),require=createRequire(path.join(cwd,'package.json'));
    const {ESLint}=require('eslint'),eslint=new ESLint({cwd});
    const manifest=JSON.parse(await readFile(path.join(cwd,'package.json'),'utf8'));
    assert.equal(manifest.scripts.lint,'eslint src --max-warnings=0');
    const check=async source=>(await eslint.lintText(source,{filePath:path.join(cwd,'src/lint-contract.ts')}))[0];
    const valid=await check('import {Injectable} from "@nestjs/common"; @Injectable() export class Service { constructor(private readonly value: string) {} read(){return this.value;} }');
    assert.equal(valid.errorCount,0);assert.equal(valid.warningCount,0);
    for(const [source,rule]of [
        ['export function unsafe(value:any){return value;}','@typescript-eslint/no-explicit-any'],
        ['export function value(){const unused=1;return 2;}','@typescript-eslint/no-unused-vars'],
        ['export function value(){try{return 1;}finally{return 2;}}','no-unsafe-finally'],
    ])assert.ok((await check(source)).messages.some(message=>message.ruleId===rule&&message.severity===2),rule);
    const deliberate=await check('export function valid(value:string){try{return !/[\\x00-\\x1f]/.test(value);}catch{throw new Error("public");}}');
    assert.equal(deliberate.errorCount,0);
    assert.ok((await check('// eslint-disable-next-line no-alert\nexport const value=1;')).errorCount>0);
    assert.equal(await eslint.isPathIgnored(path.join(cwd,'dist/output.js')),true);
    assert.equal(await eslint.isPathIgnored(path.join(cwd,'src/lint-contract.ts')),false);
});
