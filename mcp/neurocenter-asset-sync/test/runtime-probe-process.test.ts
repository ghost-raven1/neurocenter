import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProbeScope } from '../src/features/runtime-probe/process.js';

describe.skipIf(process.platform === 'win32')('Завершение только собственной группы диагностики', () => {
    let temporary: string | undefined;
    let scope: ProbeScope | undefined;
    afterEach(async () => { scope?.close(); if (temporary) { await fs.rm(temporary, { recursive: true, force: true }); } });
    it('Убивает собственный зависший процесс и его дочерний процесс, оставляя текущий worker живым', async () => {
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-probe-process-test-'));
        const file = path.join(temporary, 'parent.mjs');
        await fs.writeFile(file, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
child.on('spawn',()=>console.log(child.pid));setInterval(()=>{},1000);`);
        scope = new ProbeScope();
        const child = await scope.start(process.execPath, [file], temporary, { PATH: '', HOME: temporary }, async () => {});
        const grandchild = await new Promise<number>(resolve => child.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))));
        expect(Number.isSafeInteger(grandchild)).toBe(true); process.kill(grandchild, 0);
        scope.close();
        for (let attempt = 0; attempt < 30; attempt++) {
            try { process.kill(grandchild, 0); await new Promise(resolve => setTimeout(resolve, 20)); }
            catch { break; }
        }
        expect(() => process.kill(grandchild, 0)).toThrow();
        expect(() => process.kill(process.pid, 0)).not.toThrow();
    });
});
