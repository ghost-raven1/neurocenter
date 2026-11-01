import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const packages = [
    'api-gateway',
    'catalog-service',
    'feature-flags-service',
    'oauth2-bridge',
    'rag-sync-service',
    'skills-service',
]
    .map((name) => 'services/' + name)
    .concat('mcp/neurocenter-asset-sync');

for (const directory of packages)
    test(`${directory}: installed lint contract`, async () => {
        const cwd = path.join(root, directory),
            require = createRequire(path.join(cwd, 'package.json'));
        const { ESLint } = require('eslint'),
            eslint = new ESLint({ cwd });
        const check = async (source) =>
            (await eslint.lintText(source, { filePath: path.join(cwd, 'src/lint-contract.ts') }))[0];
        const valid = await check(
            'import {Injectable} from "@nestjs/common"; @Injectable() export class Service { constructor(private readonly value: string) {} read(){return this.value;} }',
        );
        assert.equal(valid.errorCount, 0);
        assert.equal(valid.warningCount, 0);
        for (const [source, rule] of [
            ['export function unsafe(value:any){return value;}', '@typescript-eslint/no-explicit-any'],
            ['export function value(){const unused=1;return 2;}', '@typescript-eslint/no-unused-vars'],
            ['export function value(){try{return 1;}finally{return 2;}}', 'no-unsafe-finally'],
        ])
            assert.ok(
                (await check(source)).messages.some((message) => message.ruleId === rule && message.severity === 2),
                rule,
            );
        const deliberate = await check(
            'export function valid(value:string){try{return !/[\\x00-\\x1f]/.test(value);}catch{throw new Error("public");}}',
        );
        assert.equal(deliberate.errorCount, 0);
        assert.ok((await check('// eslint-disable-next-line no-alert\nexport const value=1;')).errorCount > 0);
        assert.equal(await eslint.isPathIgnored(path.join(cwd, 'dist/output.js')), true);
        assert.equal(await eslint.isPathIgnored(path.join(cwd, 'src/lint-contract.ts')), false);
    });

for (const directory of ['', 'frontend', ...packages]) {
    test(`${directory || 'workspace'}: authored type names require I/T prefixes`, async () => {
        const cwd = path.join(root, directory);
        const { ESLint } = createRequire(path.join(cwd, 'package.json'))('eslint');
        const eslint = new ESLint({ cwd });
        const filePath = path.join(cwd, directory ? 'src/naming-contract.ts' : 'scripts/naming-contract.ts');
        const check = async (source) => (await eslint.lintText(source, { filePath }))[0];
        assert.equal(
            (await check('export interface IOptions {value: string} export type TMode = "one" | "two";')).errorCount,
            0,
        );
        for (const source of [
            'export interface Options {value: string}',
            'export interface Ioptions {value: string}',
            'export type Mode = string;',
            'export type Tmode = string;',
        ]) {
            assert.ok(
                (await check(source)).messages.some(
                    (message) => message.ruleId === '@typescript-eslint/naming-convention' && message.severity === 2,
                ),
            );
        }
    });
}

test('Vite ambient exception is restricted to its external names and declaration file', async () => {
    const cwd = path.join(root, 'frontend');
    const { ESLint } = createRequire(path.join(cwd, 'package.json'))('eslint');
    const eslint = new ESLint({ cwd });
    const source =
        'declare global {interface ImportMetaEnv {readonly VITE_BASE?: string} interface ImportMeta {readonly env: ImportMetaEnv}} export {};';
    const check = async (text, filename) => (await eslint.lintText(text, { filePath: path.join(cwd, filename) }))[0];
    assert.equal((await check(source, 'src/vite-env.d.ts')).errorCount, 0);
    assert.ok(
        (await check(source, 'src/unrelated.d.ts')).messages.some(
            (message) => message.ruleId === '@typescript-eslint/naming-convention',
        ),
    );
    assert.ok(
        (
            await check('declare global {interface Custom {value: string}} export {};', 'src/vite-env.d.ts')
        ).messages.some((message) => message.ruleId === '@typescript-eslint/naming-convention'),
    );
});

test('Axios augmentation keeps its external name only in the API owner module', async () => {
    const cwd = path.join(root, 'frontend');
    const { ESLint } = createRequire(path.join(cwd, 'package.json'))('eslint');
    const eslint = new ESLint({ cwd });
    const source =
        'declare module "axios" {interface AxiosRequestConfig {skipUnauthorizedHandler?: boolean}} export {};';
    const check = async (text, filename) => (await eslint.lintText(text, { filePath: path.join(cwd, filename) }))[0];
    assert.equal((await check(source, 'src/core/api/base.ts')).errorCount, 0);
    assert.ok(
        (await check(source, 'src/unrelated.ts')).messages.some(
            (message) => message.ruleId === '@typescript-eslint/naming-convention',
        ),
    );
    assert.ok(
        (await check('export interface Custom {value: string}', 'src/core/api/base.ts')).messages.some(
            (message) => message.ruleId === '@typescript-eslint/naming-convention',
        ),
    );
});
