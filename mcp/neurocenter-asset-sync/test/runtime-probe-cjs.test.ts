import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probePlugin } from '../src/features/runtime-probe/plugin.js';
import { createProfile, removeProfile } from '../src/features/runtime-probe/profile.js';
import { ProbeScope } from '../src/features/runtime-probe/process.js';
import { rehashPackage } from './install-set-fixture.js';
import { noop, probePackage } from './runtime-probe-fixture.js';
import { hash } from '../src/bridge/state.js';

const native = process.env.NEUROCENTER_TEST_OPENCODE_PATH;
for (const engine of ['Node', 'OpenCode/Bun']) {
    describe.skipIf(process.platform === 'win32' || engine === 'OpenCode/Bun' && !native)(`${engine}: CommonJS namespace и строгая проверка ESM`, () => {
        let root: string;
        let binary: string;
        let marker: string;
        beforeEach(async () => {
            root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-cjs-regression-'));
            marker = path.join(root, 'factories.log');
            binary = engine === 'OpenCode/Bun' ? native! : path.join(root, 'node-engine.mjs');
            if (engine === 'Node') {
                await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs/promises';
const config=JSON.parse(await fs.readFile(process.env.XDG_CONFIG_HOME+'/opencode/opencode.json','utf8'));
const mod=await import(config.plugin[0]);await mod.default({directory:process.cwd()});
`, { mode: 0o700 });
            }
        });
        afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

        async function probe(content: string, extension = 'cjs', facade = false): Promise<void> {
            const pkg = probePackage('plugin', content);
            pkg.files[0]!.path = 'plugin.' + extension;
            pkg.config = { entrypoint: pkg.files[0]!.path };
            if (facade) {
                const entrypoint = pkg.files[0]!.path + '.mjs';
                const content = `export { default } from './${pkg.files[0]!.path}';`;
                pkg.files.push({ path: entrypoint, content, size: Buffer.byteLength(content), sha256: hash(content) });
                pkg.config.entrypoint = entrypoint;
            }
            rehashPackage(pkg);
            const scope = new ProbeScope();
            const profile = await createProfile([pkg], scope);
            try { await probePlugin(pkg, profile, scope, binary, noop); }
            finally { scope.close(); await removeProfile(profile); }
        }
        const log = (value: string): string => `fs.appendFileSync(${JSON.stringify(marker)},${JSON.stringify(value + '\n')});`;

        it('CommonJS default через ESM facade инициализируется, hooks не запускаются', async () => {
            await probe(`const fs=require('node:fs');
async function plugin(){${log('default')}return {config(){throw new Error('HOOK НЕ ДОЛЖЕН РАБОТАТЬ')}}}
module.exports=plugin;`, 'cjs', true);
            expect((await fs.readFile(marker, 'utf8')).trim().split('\n')).toEqual(['default']);
        }, 20_000);

        it('ESM именованные factories и alias default сохраняют прежнее поведение', async () => {
            await probe(`import fs from 'node:fs';async function plugin(){${log('default')}return {}};
export {plugin as default,plugin as Alias};export const Other=async()=>{${log('other')}return {}};`, 'mjs');
            expect((await fs.readFile(marker, 'utf8')).trim().split('\n').sort()).toEqual(['default', 'other']);
        }, 20_000);

        it('Исключение CommonJS factory остаётся ошибкой и не раскрывает исходное сообщение', async () => {
            const failure = probe(`module.exports=async()=>{throw new Error('СЕКРЕТ_CJS_FACTORY')};`, 'cjs', true);
            await expect(failure).rejects.toMatchObject({ code: 'plugin-initialization-failed' });
            await expect(failure).rejects.not.toThrow('СЕКРЕТ_CJS_FACTORY');
        }, 20_000);

        it('Произвольный primitive export CommonJS не скрывается как метаданные функции', async () => {
            await expect(probe(`module.exports=async()=>({});module.exports.extra=123;`))
                .rejects.toMatchObject({ code: 'plugin-initialization-failed' });
        }, 20_000);

        it('ESM length и name остаются ошибкой даже при совпадении со свойствами default factory', async () => {
            await expect(probe(`async function plugin(){};export default plugin;export const length=plugin.length;export const name=plugin.name;`, 'mjs'))
                .rejects.toMatchObject({ code: 'plugin-initialization-failed' });
        }, 20_000);

        it('Raw CommonJS сохраняет прежнюю границу Node и OpenCode, без послабления probe', async () => {
            const raw = probe('module.exports=async()=>({});');
            if (engine === 'OpenCode/Bun') await expect(raw).rejects.toMatchObject({ code: 'plugin-initialization-failed' });
            else await expect(raw).resolves.toBeUndefined();
        }, 20_000);

        it('Именованный CJS object-container не становится default factory через facade', async () => {
            await expect(probe('module.exports={First:async()=>({}),Second:async()=>({})};', 'cjs', true))
                .rejects.toMatchObject({ code: 'plugin-initialization-failed' });
        }, 20_000);
    });
}
