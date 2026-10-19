import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probePlugin } from '../src/features/runtime-probe/plugin.js';
import { createProfile, removeProfile } from '../src/features/runtime-probe/profile.js';
import { ProbeScope } from '../src/features/runtime-probe/process.js';
import { noop, probePackage } from './runtime-probe-fixture.js';

const native = process.env.NEUROCENTER_TEST_OPENCODE_PATH;
for (const engine of ['Node', ...(native ? ['OpenCode/Bun'] : [])]) {
    describe.skipIf(process.platform === 'win32')(`${engine}: init плагина с фоновыми процессами`, () => {
        let root: string;
        let binary: string;
        let pids: string;
        beforeEach(async () => {
            root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-plugin-watchers-'));
            pids = path.join(root, 'owned-pids.json');
            binary = engine === 'Node' ? path.join(root, 'node-engine.mjs') : native!;
            if (engine === 'Node') {
                await fs.writeFile(binary, `#!${process.execPath}
import fs from 'node:fs/promises';
const config=JSON.parse(await fs.readFile(process.env.XDG_CONFIG_HOME+'/opencode/opencode.json','utf8'));
const plugin=await import(config.plugin[0]);await plugin.default({directory:process.cwd()});
`, { mode: 0o700 });
            }
        });
        afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

        /** Инициализированная фабрика оставляет interval и дочерний процесс в собственной группе. */
        const watchingPlugin = (file: string, fail = false): string => `import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';import {once} from 'node:events';
export default async function(){
const child=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
await once(child,'spawn');await fs.writeFile(${JSON.stringify(file)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);${fail ? "throw new Error('Приватная ошибка init');" : 'return {};'}
}`;

        async function probe(source: string, authorize = noop): Promise<void> {
            const pkg = probePackage('plugin', source);
            const scope = new ProbeScope();
            const profile = await createProfile([pkg], scope);
            try { await probePlugin(pkg, profile, scope, binary, authorize); }
            finally { scope.close(); await removeProfile(profile); }
        }

        async function assertOwnedProcessesGone(): Promise<void> {
            const owned = JSON.parse(await fs.readFile(pids, 'utf8')) as number[];
            expect(owned).toHaveLength(2);
            for (const pid of owned) {
                for (let attempt = 0; attempt < 50; attempt++) {
                    try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
                    catch { break; }
                }
                expect(() => process.kill(pid, 0)).toThrow();
            }
            expect(() => process.kill(process.pid, 0)).not.toThrow();
        }

        it('Подтверждает завершённый init и убивает interval вместе с дочерним процессом без ожидания deadline', async () => {
            const authorize = vi.fn(noop);
            await expect(probe(watchingPlugin(pids), authorize)).resolves.toBeUndefined();
            expect(authorize).toHaveBeenCalledTimes(1);
            await assertOwnedProcessesGone();
        }, 15_000);

        it('Фоновая работа не превращает исключение init в успешную диагностику', async () => {
            await expect(probe(watchingPlugin(pids, true))).rejects.toMatchObject({ status: 'failed', code: 'plugin-initialization-failed' });
            await assertOwnedProcessesGone();
        }, 15_000);

        it.each([0, 7])('Завершение процесса с кодом %s без подтверждения init отклоняется', async code => {
            await expect(probe(`export default async()=>{process.exit(${code})}`))
                .rejects.toMatchObject({ status: 'failed', code: 'plugin-initialization-failed' });
        }, 15_000);

        it('Сохраняет отказ отсутствующей зависимости и ограничение вывода до завершения init', async () => {
            await expect(probe("import absent from '@neurocenter/plugin-watchers-absent';export default async()=>({})"))
                .rejects.toMatchObject({ status: 'needs_configuration', code: 'dependency-required' });
            await expect(probe("export default async()=>{process.stderr.write('x'.repeat(1024*1024));await new Promise(()=>{});} "))
                .rejects.toMatchObject({ status: 'failed', code: 'output-limit' });
        }, 15_000);

        it('Отозванные права запрещают запуск фабрики с watcher', async () => {
            await expect(probe(watchingPlugin(pids), async () => { throw new Error('Отозвано'); }))
                .rejects.toMatchObject({ status: 'not_checked', code: 'authorization-denied' });
            await expect(fs.access(pids)).rejects.toThrow();
        }, 15_000);
    });
}
