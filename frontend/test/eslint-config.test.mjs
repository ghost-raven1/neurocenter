import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ESLint} from 'eslint';
import {describe,expect,it} from 'vitest';

const frontend=fileURLToPath(new URL('..',import.meta.url));
const eslint=new ESLint({cwd:frontend});
const check=async source=>(await eslint.lintText(source,{filePath:path.join(frontend,'src/lint-contract.tsx')}))[0];

describe('Local frontend lint contract',()=>{
    it('parses compact TypeScript and JSX without imposing formatting rules',async()=>{
        const result=await check('export function Card({title}:{title:string}){return <section>{title}</section>;}');
        expect(result.errorCount).toBe(0);expect(result.warningCount).toBe(0);
    });
    it('rejects a conditional React hook',async()=>{
        const result=await check('import {useState} from "react"; export function Card({active}:{active:boolean}){if(active)useState(0);return null;}');
        expect(result.messages).toContainEqual(expect.objectContaining({ruleId:'react-hooks/rules-of-hooks',severity:2}));
    });
    it('keeps TypeScript explicit-any checking active',async()=>{
        const result=await check('export function unsafe(value:any){return value;}');
        expect(result.messages).toContainEqual(expect.objectContaining({ruleId:'@typescript-eslint/no-explicit-any',severity:2}));
    });
    it('still rejects an unused ordinary local variable',async()=>{
        const result=await check('export function value(){const unused=1;return 2;}');
        expect(result.messages).toContainEqual(expect.objectContaining({ruleId:'@typescript-eslint/no-unused-vars',severity:2}));
    });
    it('permits deliberate rest-property omission without suppressing other unused variables',async()=>{
        const result=await check('export function visible(value:{secret:string;name:string}){const {secret:_secret,...rest}=value;return rest;}');
        expect(result.errorCount).toBe(0);
    });
    it('permits intentional forbidden-byte validators',async()=>{
        const result=await check('export function valid(value:string){return !/[\\x00-\\x1f]/.test(value);}');
        expect(result.errorCount).toBe(0);
    });
    it('permits safe public errors in place of sensitive transport causes',async()=>{
        const result=await check('export function fail(){try{throw new Error("private");}catch(cause){if(cause instanceof Error)throw new Error("public");throw cause;}}');
        expect(result.errorCount).toBe(0);
    });
    it('reports missing hook dependencies as visible warnings',async()=>{
        const result=await check('import {useEffect} from "react";export function Card({value}:{value:string}){useEffect(()=>{console.log(value);},[]);return null;}');
        expect(result.messages).toContainEqual(expect.objectContaining({ruleId:'react-hooks/exhaustive-deps',severity:1}));
    });
    it('rejects unused suppression directives',async()=>{
        const result=await check('// eslint-disable-next-line no-alert\nexport const value=1;');
        expect(result.messages).toContainEqual(expect.objectContaining({severity:2,message:expect.stringContaining('Unused eslint-disable directive')}));
    });
});
