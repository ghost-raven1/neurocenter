import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRuntimeProbe } from '../src/features/runtime-probe/index.js';
import { ProbeScope } from '../src/features/runtime-probe/process.js';
import * as profiles from '../src/features/runtime-probe/profile.js';
import { assetBase } from '../src/bridge/installation-receipt.js';
import { bindProject } from '../src/bridge/workspace.js';
import { installSet } from '../src/bridge/installer.js';
import { packageRef } from '../src/bridge/install-set.js';
import { workspaceFixture } from './bridge-fixture.js';
import { rehashPackage, setFixture } from './install-set-fixture.js';
import { fakeEngine, mcpSource, noop, probeInput, probePackage, snapshot } from './runtime-probe-fixture.js';

describe.skipIf(process.platform === 'win32')('Явная ограниченная runtime диагностика установленного набора', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let engine: Awaited<ReturnType<typeof fakeEngine>>;
    beforeEach(async () => { fixture = await workspaceFixture(); engine = await fakeEngine(fixture.temporary); });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Проверяет структуру и ресурсы скилла, сохраняя байты и mtime рабочего проекта', async () => {
        const pkg = probePackage();
        pkg.files[0]!.content += '\n[Скрипт](scripts/check.mjs)';
        pkg.files[0]!.size = Buffer.byteLength(pkg.files[0]!.content);
        const { hash } = await import('../src/bridge/state.js'); pkg.files[0]!.sha256 = hash(pkg.files[0]!.content);
        const marker = path.join(fixture.temporary, 'НЕЛЬЗЯ_ВЫПОЛНЯТЬ');
        const script = `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'Запуск');`;
        pkg.files.push({ path: 'scripts/check.mjs', content: script, size: Buffer.byteLength(script), sha256: hash(script) }); rehashPackage(pkg);
        const input = await probeInput(pkg, engine); const before = await snapshot(fixture.temporary);
        const result = await runRuntimeProbe(input);
        expect(result).toMatchObject({ status: 'passed', code: 'verified', manifest: pkg.manifest.sha256, approvalManifest: pkg.manifest.sha256,
            counts: { packages: 1, files: 2, skills: 1, pluginsInitialized: 0, mcp: 0 } });
        expect(await snapshot(fixture.temporary)).toEqual(before); await expect(fs.access(marker)).rejects.toThrow();
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8500);
    });
    it('Отказывает до запуска при отсутствии согласия, несовпадении SHA и лишнем члене графа', async () => {
        const input = await probeInput(probePackage(), engine); const authorize = vi.fn(noop); input.authorize = authorize;
        expect(await runRuntimeProbe({ ...input, consentManifest: '0'.repeat(64) })).toMatchObject({ status: 'not_checked', code: 'not-approved' });
        expect(authorize).not.toHaveBeenCalled();
        expect(await runRuntimeProbe({ ...input, openCode: { ...engine, sha256: '0'.repeat(64) } })).toMatchObject({ status: 'unsupported', code: 'runtime-mismatch' });
        const extra = probePackage('mcp', 'throw new Error()'); const set = setFixture(input.frozenSet.packages[0]!, [extra]);
        expect(await runRuntimeProbe({ ...input, frozenSet: set, consentManifest: set.manifest })).toMatchObject({ status: 'not_checked', code: 'invalid-package' });
    });
    it('Не запускает ручную подмену, не восстанавливает pending и обнаруживает другую привязку', async () => {
        const pkg = probePackage(); const input = await probeInput(pkg, engine); const authorize = vi.fn(noop); input.authorize = authorize;
        const file = path.join(fixture.root, assetBase(pkg), 'SKILL.md'); await fs.writeFile(file, 'Подмена');
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'stale', code: 'installation-not-current' }); expect(authorize).not.toHaveBeenCalled();
        await fs.writeFile(file, pkg.files[0]!.content);
        await fs.writeFile(path.join(fixture.root, '.opencode/neurocenter/files.lock'), 'Не трогать');
        const before = await snapshot(fixture.temporary);
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'busy', code: 'inspection-busy' }); expect(await snapshot(fixture.temporary)).toEqual(before);
        await fs.rm(path.join(fixture.root, '.opencode/neurocenter/files.lock'));
        await fs.mkdir(path.join(path.dirname(fixture.root), 'другая папка')); await bindProject('test-project', 'другая папка');
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'stale', code: 'installation-not-current' });
    });
    it('Повторно авторизует каждый spawn и блокирует параллельную диагностику той же привязки', async () => {
        const log = path.join(fixture.temporary, 'методы.log'); const pkg = probePackage('mcp', mcpSource(log));
        const input = await probeInput(pkg, engine);
        let unblock: () => void = () => {}; const gate = new Promise<void>(resolve => { unblock = resolve; });
        let entered: () => void = () => {}; const ready = new Promise<void>(resolve => { entered = resolve; });
        input.authorize = vi.fn(async () => { entered(); await gate; });
        const first = runRuntimeProbe(input); await ready;
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'busy', code: 'inspection-busy' }); unblock();
        expect(await first).toMatchObject({ status: 'passed', counts: { mcp: 1 } }); expect(input.authorize).toHaveBeenCalledTimes(6);
        await fs.rm(log);
        let calls = 0; input.authorize = async () => { if (++calls === 2) { throw new Error('СЕКРЕТ_СЕРВЕРА'); } };
        const denied = await runRuntimeProbe(input);
        expect(denied).toMatchObject({ status: 'not_checked', code: 'authorization-denied' }); expect(JSON.stringify(denied)).not.toContain('СЕКРЕТ_СЕРВЕРА');
        await expect(fs.access(log)).rejects.toThrow();
    });
    it('MCP выполняет настоящий handshake и списки, не вызывает tools и не передает секреты', async () => {
        const log = path.join(fixture.temporary, 'методы.log'); const pkg = probePackage('mcp', mcpSource(log, `if(process.env.SECRET_HOST)process.exit(14);console.error('СЕКРЕТ_ЛОГА');`));
        vi.stubEnv('SECRET_HOST', 'НЕЛЬЗЯ_НАСЛЕДОВАТЬ');
        const result = await runRuntimeProbe(await probeInput(pkg, engine));
        expect(result).toMatchObject({ status: 'passed', counts: { mcp: 1, tools: 1, resources: 1, prompts: 1 } });
        expect((await fs.readFile(log, 'utf8')).trim().split('\n')).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list']);
        const text = JSON.stringify(result);
        for (const secret of [fixture.temporary, 'СЕКРЕТ_ЛОГА', 'СЕКРЕТ_ИНСТРУМЕНТА', 'Секретное имя', 'test://secret', 'НЕЛЬЗЯ_НАСЛЕДОВАТЬ']) { expect(text).not.toContain(secret); }
    });
    it('Отзыв прав после MCP handshake запрещает списки и не возвращает passed', async () => {
        const log = path.join(fixture.temporary, 'методы.log');
        const input = await probeInput(probePackage('mcp', mcpSource(log)), engine);
        input.authorize = async () => {
            if (await fs.stat(log).catch(() => undefined)) { throw new Error('Права отозваны'); }
        };
        const result = await runRuntimeProbe(input);
        expect(result).toMatchObject({ status: 'not_checked', code: 'authorization-denied', counts: { mcp: 0 } });
        expect(await fs.readFile(log, 'utf8')).not.toContain('tools/list');
    });
    it('Отзыв прав после последнего списка не подтверждает финальный результат диагностики', async () => {
        const log = path.join(fixture.temporary, 'методы.log');
        const input = await probeInput(probePackage('mcp', mcpSource(log)), engine);
        input.authorize = async () => {
            const methods = await fs.readFile(log, 'utf8').catch(() => '');
            if (methods.includes('prompts/list')) { throw new Error('СЕКРЕТ_ОТЗЫВА_ПРАВ'); }
        };
        const result = await runRuntimeProbe(input);
        expect(result).toMatchObject({ status: 'not_checked', code: 'authorization-denied', counts: { mcp: 1 } });
        expect(JSON.stringify(result)).not.toContain('СЕКРЕТ_ОТЗЫВА_ПРАВ');
    });
    it('Останавливает повторяющийся cursor MCP и ограничивает flood вывода', async () => {
        const log = path.join(fixture.temporary, 'методы.log');
        const source = mcpSource(log).replace('result={tools:[', "result={nextCursor:'repeat',tools:[");
        expect(await runRuntimeProbe(await probeInput(probePackage('mcp', source), engine)))
            .toMatchObject({ status: 'failed', code: 'output-limit' });
        expect((await fs.readFile(log, 'utf8')).match(/tools\/list/g)).toHaveLength(2);
        const flood = probePackage('mcp', `process.stderr.write('s'.repeat(9*1024*1024));setInterval(()=>{},1000)`);
        expect(await runRuntimeProbe(await probeInput(flood, engine))).toMatchObject({ status: 'failed', code: 'output-limit' });
    });
    it.each(['Нет YAML', '---\nname: runtime-check\ndescription: Проверка\n---\n[Нет ресурса](missing.txt)'])('Не подтверждает некорректный скилл или отсутствующий ресурс: %s', async content => {
        expect(await runRuntimeProbe(await probeInput(probePackage('skill', content), engine)))
            .toMatchObject({ status: 'needs_configuration', code: 'invalid-skill' });
    });
    it('FIFO и symlink вместо pinned бинарника не блокируют диагностику', async () => {
        const input = await probeInput(probePackage(), engine);
        const fifo = path.join(fixture.temporary, 'engine.fifo'); execFileSync('mkfifo', [fifo]);
        const link = path.join(fixture.temporary, 'engine.link'); await fs.symlink(engine.path, link);
        for (const file of [fifo, link]) {
            expect(await runRuntimeProbe({ ...input, openCode: { ...engine, path: file } }))
                .toMatchObject({ status: 'unsupported', code: 'runtime-unavailable' });
        }
    });
    it('Авторизация не может незаметно подменить frozen package или бинарник', async () => {
        const pkg = probePackage(); const input = await probeInput(pkg, engine);
        input.authorize = async () => { pkg.files[0]!.content = 'Подмена callback'; };
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'passed' });
        // Новый input содержит исходный серверный snapshot, бинарник меняется после первого preflight.
        const clean = await probeInput(probePackage(), engine);
        clean.authorize = async () => { await fs.appendFile(engine.path, '// подмена'); };
        expect(await runRuntimeProbe(clean)).toMatchObject({ status: 'unsupported', code: 'runtime-mismatch' });
    });
    it('Remote MCP с 401 не начинает OAuth и возвращает потребность настройки', async () => {
        const methods: string[] = [];
        const server = http.createServer((request, response) => { methods.push(`${request.method} ${request.url}`); response.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1:1/secret"' }); response.end(); });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        try {
            const port = (server.address() as { port: number }).port;
            const pkg = probePackage('mcp', ''); pkg.files = []; pkg.config = { transport: 'remote', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: 'Bearer TOKEN_SECRET' } }; rehashPackage(pkg);
            const result = await runRuntimeProbe(await probeInput(pkg, engine));
            expect(result).toMatchObject({ status: 'needs_configuration', code: 'configuration-required' });
            expect(methods).toEqual(['POST /mcp']); expect(JSON.stringify(result)).not.toContain('TOKEN_SECRET');
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    it('Граф использует SET consent и диагностирует только точное замыкание', async () => {
        const log = path.join(fixture.temporary, 'методы.log'); const mcp = probePackage('mcp', mcpSource(log));
        const root = probePackage(); root.config = { extra: { requirements: { dependencies: [packageRef(mcp)] } } }; rehashPackage(root);
        const set = setFixture(root, [mcp]); await installSet('test-project', set, noop, noop);
        const { projectBindingId } = await import('../src/bridge/workspace.js');
        const result = await runRuntimeProbe({ projectId: 'test-project', bindingId: await projectBindingId('test-project'), target: packageRef(root), frozenSet: set,
            consentManifest: set.manifest, openCode: engine, authorize: noop });
        expect(result).toMatchObject({ status: 'passed', manifest: root.manifest.sha256, approvalManifest: set.manifest, counts: { packages: 2, skills: 1, mcp: 1 } });
    });
    it('Финальная повторная сверка отвергает изменение после авторизации', async () => {
        const pkg = probePackage(); const input = await probeInput(pkg, engine);
        input.authorize = async () => { await fs.writeFile(path.join(fixture.root, assetBase(pkg), 'SKILL.md'), 'Изменено во время проверки'); };
        expect(await runRuntimeProbe(input)).toMatchObject({ status: 'stale', code: 'installation-not-current' });
    });
    it('Ошибка cleanup после handshake сохраняет согласованные счетчики для failed completion', async () => {
        const pkg = probePackage('mcp', mcpSource(path.join(fixture.temporary, 'методы.log')));
        const remove = profiles.removeProfile; let calls = 0;
        vi.spyOn(profiles, 'removeProfile').mockImplementation(async profile => {
            await remove(profile);
            if (++calls === 2) throw new Error('СЕКРЕТ_ОШИБКИ_CLEANUP');
        });
        const result = await runRuntimeProbe(await probeInput(pkg, engine));
        expect(result).toMatchObject({ status: 'failed', code: 'probe-failed', counts: { packages: 1, mcp: 1, skills: 0, pluginsInitialized: 0 } });
        expect(result.counts.skills + result.counts.mcp + result.counts.pluginsInitialized).toBe(result.counts.packages);
        expect(JSON.stringify(result)).not.toContain('СЕКРЕТ_ОШИБКИ_CLEANUP');
    });
    it('Не запускает npx и не наследует опасные переменные пакета', async () => {
        for (const config of [{ command: 'npx', args: ['-y', 'anything'] }, { command: 'node', entrypoint: 'index.mjs', env: { NODE_OPTIONS: '--require=/private/secret' } }]) {
            const pkg = probePackage('mcp', ''); pkg.config = config; if (!config.entrypoint) { pkg.files = []; } rehashPackage(pkg);
            expect(await runRuntimeProbe(await probeInput(pkg, engine))).toMatchObject({ status: 'unsupported', code: config.entrypoint ? 'unsafe-environment' : 'external-command-unsupported' });
        }
    });
    it('Общий deadline истекает через 59 секунд независимо от текущего этапа', async () => {
        vi.useFakeTimers(); const scope = new ProbeScope(); const pending = scope.wait(new Promise(() => {}));
        const assertion = expect(pending).rejects.toMatchObject({ status: 'failed', code: 'timeout' });
        await vi.advanceTimersByTimeAsync(59_000); await assertion; scope.close();
    });
});
