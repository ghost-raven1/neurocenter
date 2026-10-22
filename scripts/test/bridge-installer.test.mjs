import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {readBridgeTemplate} from '../workspace/bridge-templates.mjs';

const script = fileURLToPath(new URL('../../bridge-dist/install.sh', import.meta.url));
const version = JSON.parse(await fs.readFile(new URL('../../mcp/neurocenter-asset-sync/package.json', import.meta.url), 'utf8')).version;
const renderedTemplate=(await readBridgeTemplate(script)).replace('__BRIDGE_VERSION__',version).replace('__SITE_URL__','https://platform.example');
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
test('Оба установщика, протокол и lock-файл раздают текущую версию моста', async () => {
    const bash = await fs.readFile(script, 'utf8');
    const powershell = await fs.readFile(new URL('../../bridge-dist/install.ps1', import.meta.url), 'utf8');
    const {BRIDGE_VERSION} = await import(new URL('../../mcp/neurocenter-asset-sync/src/bridge/protocol.ts', import.meta.url));
    const lock = JSON.parse(await fs.readFile(new URL('../../mcp/neurocenter-asset-sync/package-lock.json', import.meta.url), 'utf8'));
    assert.equal(/^VERSION='([^']+)'/m.exec(bash)?.[1], '__BRIDGE_VERSION__');
    assert.equal(/^\$Version = '([^']+)'/m.exec(powershell)?.[1], '__BRIDGE_VERSION__');
    assert.equal(BRIDGE_VERSION, version);
    assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
});
async function fixture(platform = 'Darwin', arch = 'arm64', libc = 'glibc') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-offline-installer-')); roots.push(root);
    for (const folder of ['fake-bin', 'package/bin', 'package/dist']) await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, 'package/package.json'), JSON.stringify({ name: 'neurocenter-asset-sync', version }));
    await fs.writeFile(path.join(root, 'package/dist/index.js'), '// Пакет для проверки установщика');
    await fs.writeFile(path.join(root,'package/dist/bridge-cli.js'),'// Short CLI fixture');
    const buildId = 'a'.repeat(64);
    await fs.writeFile(path.join(root, 'package/dist/build.json'), JSON.stringify({ version, buildId }));
    const runtimePlatform = platform === 'Darwin' ? 'darwin' : 'linux';
    const runtimeArch = ['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'x64';
    await fs.writeFile(path.join(root, 'package/runtime.json'), JSON.stringify({ version, buildId, nodeVersion: '24.22.0', target: `${runtimePlatform}-${runtimeArch}${libc === 'musl' ? '-musl' : ''}` }));
    await fs.writeFile(path.join(root, 'package/bin/node'), `#!/bin/sh
case "$1" in
    --version) echo "\${TEST_NODE_VERSION:-v24.22.0}" ;;
    -p) echo "$TEST_NODE_PLATFORM:$TEST_NODE_ARCH" ;;
    -e) exec "$TEST_FORMATTER_NODE" "$@" ;;
    -) exec "$TEST_FORMATTER_NODE" "$@" ;;
    *)
        echo "$*" >> "$TEST_ROOT/events"
        printf '%s %s\\n' "$2" "$NEUROCENTER_URL" >> "$TEST_ROOT/site-origins"
        if [ "$2" = --install-command ]; then
            echo "$HOME/.local/bin/neurocenter-bridge"
        elif [ "$2" = --prepare-upgrade ]; then
            if [ "\${TEST_FAIL_UPGRADE:-0}" = 1 ]; then
                printf '%s' '{"ok":false,"error":"На компьютере выполняется задание"}'
                exit 1
            fi
            if [ -n "\${TEST_UPGRADE_RESULT:-}" ]; then printf '%s' "$TEST_UPGRADE_RESULT";
            elif [ -n "\${TEST_UPGRADE_PAUSED:-}" ]; then printf '{"ok":true,"paused":%s}' "$TEST_UPGRADE_PAUSED";
            else printf '%s' '{"ok":true,"paused":true}'; fi
        elif [ "$2" = --finish-upgrade ]; then
            if [ "\${TEST_FAIL_FINISH:-0}" = 1 ]; then
                printf '%s' '{"ok":false,"error":"Подключение не настроено"}'
                exit 1
            fi
            if [ -n "\${TEST_FINISH_RESULT:-}" ]; then printf '%s' "$TEST_FINISH_RESULT"; else printf '%s' '{"ok":true}'; fi
        elif [ "$2" = --init ]; then
            if [ -n "\${TEST_INIT_GATE:-}" ]; then
                touch "$TEST_INIT_GATE.started"
                while [ ! -f "$TEST_INIT_GATE.release" ]; do /bin/sleep .02; done
            fi
            if [ "\${TEST_FAIL_INIT:-0}" = 1 ]; then
                printf '%s' '{"ok":false,"error":"Конфигурация OpenCode недоступна"}'
                exit 1
            fi
            if [ -n "\${TEST_INIT_RESULT:-}" ]; then printf '%s' "$TEST_INIT_RESULT";
            else printf '{"ok":true,"configPath":"%s/config/opencode.jsonc","created":false,"method":"jsonc"}' "$TEST_ROOT"; fi
        else
            if [ "\${TEST_FAIL_CONNECT:-0}" = 1 ]; then
                echo 'Активное задание MCP ещё не завершено' >&2
                exit 1
            fi
            if [ -n "\${TEST_CONNECT_RESULT:-}" ]; then printf '%s\\n' "$TEST_CONNECT_RESULT";
            else printf '%s\\n' '{"connected":true,"deviceId":"fixture-computer","note":"Компьютер уже подключён"}'; fi
        fi
        ;;
esac
`, { mode: 0o755 });
    await fs.writeFile(path.join(root, 'fake-bin/uname'), '#!/bin/sh\nif [ "$1" = -s ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'fake-bin/ldd'), '#!/bin/sh\necho "$TEST_LIBC"\nif [ "$TEST_LIBC" = musl ]; then exit 1; fi\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'fake-bin/sysctl'), '#!/bin/sh\necho "${TEST_HW_ARM64:-0}"\n', { mode: 0o755 });
    for (const name of ['node', 'npm']) await fs.writeFile(path.join(root, 'fake-bin', name), '#!/bin/sh\necho forbidden >> "$TEST_ROOT/external-runtime"\nexit 99\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, 'fake-bin/curl'), '#!/bin/sh\necho "$2" >> "$TEST_ROOT/urls"\ncase "$2" in *.sha256) if [ "${TEST_BAD_HASH:-0}" = 1 ]; then echo bad > "$4"; else cp "$TEST_ROOT/package.sha256" "$4"; fi ;; *) cp "$TEST_ROOT/package.tgz" "$4" ;; esac\n', { mode: 0o755 });
    const pack = async () => {
        execFileSync('tar', ['-czf', path.join(root, 'package.tgz'), '-C', path.join(root, 'package'), 'bin', 'dist', 'package.json', 'runtime.json']);
        await fs.writeFile(path.join(root, 'package.sha256'), createHash('sha256').update(await fs.readFile(path.join(root, 'package.tgz'))).digest('hex') + '\n');
    };
    await pack();
    const env = { ...process.env, PATH: path.join(root, 'fake-bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', HOME: root, XDG_CONFIG_HOME: path.join(root,'.config'),
        BASE_URL: 'https://platform.example/api/bridge', INSTALL_DIR: path.join(root, 'installed'), TEST_ROOT: root,
        TEST_OS: platform, TEST_ARCH: arch, TEST_LIBC: libc, TEST_FORMATTER_NODE: process.execPath,
        TEST_NODE_PLATFORM: platform === 'Darwin' ? 'darwin' : 'linux', TEST_NODE_ARCH: ['arm64', 'aarch64'].includes(arch) ? 'arm64' : 'x64' };
    const scriptPath=path.join(root,'install.sh');await fs.writeFile(scriptPath,renderedTemplate);
    const run = (overrides = {}, source = scriptPath) => {
        const result = spawnSync('bash', [source], { env: { ...env, ...overrides }, encoding: 'utf8' });
        return result;
    };
    return { root, env, run, pack, scriptPath };
}
for(const platform of ['Darwin','Linux'])test(`Установщик ${platform} скачивает с Gateway и сохраняет площадку при установке и reconnect`,async()=>{
    const f=await fixture(platform),gateway='https://gateway.example.test/api/bridge',site='https://panel.example.test';
    const rendered=renderedTemplate.replace("RECONNECT='__RECONNECT__'","RECONNECT='1'");
    await fs.writeFile(f.scriptPath,rendered);
    assert.equal(f.run({BASE_URL:gateway,SITE_URL:site}).status,0);
    const urls=(await fs.readFile(path.join(f.root,'urls'),'utf8')).trim().split('\n');
    assert.equal(urls.length,2);assert.ok(urls.every(url=>url.startsWith(gateway+'/runtime/')));assert.ok(urls[1].endsWith('.tgz.sha256'));
    const observed=(await fs.readFile(path.join(f.root,'site-origins'),'utf8')).trim().split('\n');
    assert.deepEqual(observed,[`--init ${site}`,`--install-command ${site}`,`--reconnect-open ${site}`]);
    assert.equal(f.run({BASE_URL:gateway,SITE_URL:site}).status,0);
    const upgrade=(await fs.readFile(path.join(f.root,'site-origins'),'utf8')).trim().split('\n').slice(3);
    assert.deepEqual(upgrade,[`--prepare-upgrade ${site}`,`--init ${site}`,`--finish-upgrade ${site}`,`--install-command ${site}`,`--reconnect-open ${site}`]);
});
for (const [platform, arch, libc, target] of [['Darwin', 'arm64', 'glibc', 'darwin-arm64'], ['Darwin', 'x86_64', 'glibc', 'darwin-x64'],
    ['Linux', 'x86_64', 'glibc', 'linux-x64'], ['Linux', 'aarch64', 'glibc', 'linux-arm64'],
    ['Linux', 'x86_64', 'musl', 'linux-x64-musl'], ['Linux', 'aarch64', 'musl', 'linux-arm64-musl']]) {
    test(`Автономный MCP выбирает ${target} без системных Node и npm`, async () => {
        const f = await fixture(platform, arch, libc); const result = f.run(); assert.equal(result.status, 0, result.stderr);
        assert.ok((await fs.readFile(path.join(f.root, 'urls'), 'utf8')).includes(`neurocenter-asset-sync-${target}-${version}.tgz`));
        await assert.rejects(fs.access(path.join(f.root, 'external-runtime')), { code: 'ENOENT' });
    });
}
test('Повреждённая контрольная сумма не заменяет существующую установку', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR); await fs.writeFile(path.join(f.env.INSTALL_DIR, 'личный.txt'), 'сохранить');
    assert.notEqual(f.run({ TEST_BAD_HASH: '1' }).status, 0);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'личный.txt'), 'utf8'), 'сохранить');
});
test('Ссылки в архиве отклоняются до запуска runtime', async () => {
    const f = await fixture(); await fs.symlink('/tmp', path.join(f.root, 'package/dist/link')); await f.pack();
    assert.notEqual(f.run().status, 0); await assert.rejects(fs.access(path.join(f.root, 'events')), { code: 'ENOENT' });
});
test('Сбой регистрации возвращает прежнюю версию MCP', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR); await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
    assert.notEqual(f.run({ TEST_FAIL_INIT: '1' }).status, 0);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
});
test('Незавершённое задание запрещает замену установленного моста и регистрацию', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
    const result = f.run({ TEST_FAIL_UPGRADE: '1' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.env.INSTALL_DIR, 'package.json'), 'utf8')).version, '0.9.0');
    const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
    assert.match(attempts, /--prepare-upgrade/);
    assert.doesNotMatch(attempts, /--init|--connect-open/);
    assert.deepEqual((await fs.readdir(path.dirname(f.env.INSTALL_DIR))).filter(name => name.startsWith('.neurocenter-previous.')), []);
    const retry = f.run();
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.env.INSTALL_DIR, 'package.json'), 'utf8')).version, version);
});
test('Обновление без подключения не требует снятия отсутствующей паузы перед подключением', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    const result = f.run({ TEST_UPGRADE_PAUSED: 'false', TEST_FAIL_FINISH: '1' });
    assert.equal(result.status, 0, result.stderr);
    const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
    assert.match(attempts, /--prepare-upgrade/);
    assert.match(attempts, /--init/);
    assert.match(attempts, /--connect-open/);
    assert.doesNotMatch(attempts, /--finish-upgrade/);
    assert.match(result.stdout, /Готово! MCP установлен и подключён/);
});
for (const paused of ['true', '']) {
    test(`Обновление снимает паузу перед подключением, ${paused ? 'пауза подтверждена' : 'старый ответ без признака паузы'}`, async () => {
        const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
        await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
        const result = f.run({ TEST_UPGRADE_PAUSED: paused });
        assert.equal(result.status, 0, result.stderr);
        const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
        assert.equal(attempts.match(/--finish-upgrade/g)?.length, 1);
        assert.ok(attempts.indexOf('--prepare-upgrade') < attempts.indexOf('--init'));
        assert.ok(attempts.indexOf('--init') < attempts.indexOf('--finish-upgrade'));
        assert.ok(attempts.indexOf('--finish-upgrade') < attempts.indexOf('--connect-open'));
    });
}
test('Сбой регистрации без паузы не запускает снятие паузы при откате', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
    const result = f.run({ TEST_UPGRADE_PAUSED: 'false', TEST_FAIL_INIT: '1', TEST_FAIL_FINISH: '1' });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /Конфигурация OpenCode недоступна/);
    assert.doesNotMatch(result.stderr, /Не удалось снять паузу|очередь не подтвердила/);
    const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
    assert.match(attempts, /--init/);
    assert.doesNotMatch(attempts, /--finish-upgrade|--connect-open/);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
});
for (const upgrade of [{ ok: false, error: 'Обновление отклонено' }, { paused: false }]) {
    test(`Неподтверждённая подготовка не заменяет мост: ${JSON.stringify(upgrade)}`, async () => {
        const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
        await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
        await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
        const result = f.run({ TEST_UPGRADE_RESULT: JSON.stringify(upgrade) });
        assert.notEqual(result.status, 0, result.stdout);
        assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
        const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
        assert.match(attempts, /--prepare-upgrade/);
        assert.doesNotMatch(attempts, /--init|--connect-open/);
        assert.equal(attempts.split('--finish-upgrade').length-1,1,'Отказ CLI не подтверждает снятие возможной паузы');
    });
}
for (const field of ['version', 'buildId']) {
    test(`Несогласованное поле ${field} архива отклоняется до замены и регистрации`, async () => {
        const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
        await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
        await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
        const file = path.join(f.root, 'package/dist/build.json');
        const build = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(file, JSON.stringify({ ...build, [field]: field === 'version' ? '0.1.0' : 'b'.repeat(64) }));
        await f.pack();
        const result = f.run();
        assert.notEqual(result.status, 0, result.stdout);
        assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
        await assert.rejects(fs.access(path.join(f.root, 'events')), { code: 'ENOENT' });
    });
}
test('Параллельный установщик не сообщает успех перед чужим откатом', { timeout: 15000 }, async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
    const gate = path.join(f.root, 'init-gate');
    const child = spawn('bash', [f.scriptPath], { env: { ...f.env, TEST_INIT_GATE: gate, TEST_FAIL_INIT: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => error += chunk);
    const finished = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    let second, firstCode;
    try {
        const deadline = Date.now() + 8000;
        while (!await fs.access(gate + '.started').then(() => true, () => false)) {
            assert.ok(Date.now() < deadline, 'Первый установщик не дошёл до регистрации: ' + error);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        second = f.run();
    } finally {
        await fs.writeFile(gate + '.release', 'продолжить');
        firstCode = await finished;
    }
    assert.notEqual(firstCode, 0, error);
    assert.notEqual(second.status, 0, 'Второй установщик сообщил успех, который отменил откат первого');
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.env.INSTALL_DIR, 'package.json'), 'utf8')).version, '0.9.0');
    const attempts = await fs.readFile(path.join(f.root, 'events'), 'utf8');
    assert.equal(attempts.match(/--init/g)?.length, 1);
});
test('Несовместимая прежняя версия сохраняется отдельно без автоматического возврата после отказа init', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"0.8.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'прежняя несовместимая программа');
    const result = f.run({ TEST_FAIL_INIT: '1' }); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /откат на несовместимую версию запрещён/);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.env.INSTALL_DIR, 'package.json'), 'utf8')).version, version);
    const [previous] = (await fs.readdir(path.dirname(f.env.INSTALL_DIR))).filter(name => name.startsWith('.neurocenter-previous.'));
    assert.ok(previous); assert.equal(await fs.readFile(path.join(path.dirname(f.env.INSTALL_DIR), previous, 'previous'), 'utf8'), 'прежняя несовместимая программа');
    assert.doesNotMatch(await fs.readFile(path.join(f.root, 'events'), 'utf8'), /--connect-open/);
});
test('Реальная semver-проверка запрещает downgrade до замены программы и init', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR);
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"neurocenter-asset-sync","version":"1.0.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR, 'previous'), 'сохранить');
    const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /понижение версии MCP запрещено/);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR, 'previous'), 'utf8'), 'сохранить');
    await assert.rejects(fs.access(path.join(f.root, 'events')), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(path.dirname(f.env.INSTALL_DIR))).filter(name => name.startsWith('.neurocenter-previous.')), []);
});
test('Посторонняя папка не переименовывается установщиком', async () => {
    const f = await fixture(); await fs.mkdir(f.env.INSTALL_DIR); await fs.writeFile(path.join(f.env.INSTALL_DIR, 'package.json'), '{"name":"other"}');
    assert.notEqual(f.run().status, 0); assert.ok(await fs.stat(f.env.INSTALL_DIR));
});
test('Явное переподключение передаёт режим смены роли, обычный запуск сохраняет подключение', async () => {
    const f = await fixture(); const source = path.join(f.root, 'reconnect.sh');
    await fs.writeFile(source, renderedTemplate.replace('__RECONNECT__', '1'));
    assert.equal(f.run({}, source).status, 0);
    assert.ok((await fs.readFile(path.join(f.root, 'events'), 'utf8')).includes('--reconnect-open'));
});
test('Rosetta не заставляет Apple Silicon скачивать неподходящий Intel-пакет', async () => {
    const f = await fixture('Darwin', 'x86_64');
    const metadata = path.join(f.root, 'package/runtime.json');
    await fs.writeFile(metadata, JSON.stringify({ ...JSON.parse(await fs.readFile(metadata, 'utf8')), target: 'darwin-arm64' }));
    await f.pack();
    assert.equal(f.run({ TEST_HW_ARM64: '1', TEST_NODE_ARCH: 'arm64' }).status, 0);
    assert.ok((await fs.readFile(path.join(f.root, 'urls'), 'utf8')).includes('darwin-arm64'));
});
test('Неправильно подписанная архитектура архива не заменяет установленный MCP', async () => {
    const f = await fixture(); assert.notEqual(f.run({ TEST_NODE_ARCH: 'x64' }).status, 0);
    await assert.rejects(fs.access(f.env.INSTALL_DIR), { code: 'ENOENT' });
});

test('Установщик показывает этапы и итог без сырого JSON и ANSI в журнале', async () => {
    const f = await fixture(); const result = f.run({ NO_COLOR: '1' });
    assert.equal(result.status, 0, result.stderr);
    for (const step of ['[1/4]', '[2/4]', '[3/4]', '[4/4]']) assert.ok(result.stdout.includes(step));
    assert.match(result.stdout, /Конфигурация: .*opencode\.jsonc/);
    assert.match(result.stdout, /Существующее подключение сохранено, дубликат не создан/);
    assert.match(result.stdout, /Готово! MCP установлен и подключён/);
    assert.match(result.stdout, /Перезапустите OpenCode/);
    assert.doesNotMatch(result.stdout, /"ok"|"connected"|\x1b\[/);
});
test('Вывод работает при передаче скрипта в Bash через stdin, как curl | bash', async () => {
    const f = await fixture();
    const result = spawnSync('bash', [], { env: f.env, input: renderedTemplate, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[4\/4\] Проверяем подключение/);
    assert.match(result.stdout, /Готово! MCP установлен и подключён/);
    assert.doesNotMatch(result.stdout, /"ok"|"connected"/);
});
test('Новая конфигурация OpenCode названа созданной, а не обновлённой', async () => {
    const f = await fixture();
    const result = f.run({ TEST_INIT_RESULT: JSON.stringify({ ok: true, created: true, configPath: '/папка с пробелами/opencode.json' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Создана конфигурация OpenCode/);
    assert.match(result.stdout, /Конфигурация: \/папка с пробелами\/opencode\.json/);
});
for (const browserOpened of [false, true]) {
    test(`Ожидание подтверждения не выдаётся за подключение, браузер ${browserOpened ? 'открыт' : 'недоступен'}`, async () => {
        const f = await fixture(); const pending = { url: 'https://platform.example/start?step=1&connect=FIXTURE', code: 'FIXTURE', fingerprint: 'a'.repeat(64), expiresIn: 590, browserOpened };
        const result = f.run({ TEST_CONNECT_RESULT: JSON.stringify(pending) });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Подключение ждёт подтверждения/);
        for (const value of [pending.url, pending.code, pending.fingerprint, '10 мин.']) assert.ok(result.stdout.includes(value));
        assert.doesNotMatch(result.stdout, /Готово!|Компьютер уже подключён/);
        assert.equal((await fs.readFile(path.join(f.root, 'events'), 'utf8')).match(/--connect-open/g)?.length, 1);
    });
}
test('Причина ошибки регистрации выводится до сообщения об откате', async () => {
    const f = await fixture(); const result = f.run({ TEST_FAIL_INIT: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Конфигурация OpenCode недоступна/);
    assert.doesNotMatch(result.stderr, /"ok"|"error"/);
});
test('Ошибка подключения сохраняет stderr и не показывает успешное завершение', async () => {
    const f = await fixture(); const result = f.run({ TEST_FAIL_CONNECT: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Активное задание MCP ещё не завершено/);
    assert.doesNotMatch(result.stdout, /Готово!/);
});
test('Управляющие последовательности из ответа не исполняются терминалом', async () => {
    const f = await fixture(); const result = f.run({ TEST_INIT_RESULT: JSON.stringify({ ok: true, configPath: '/tmp/\u001b[31m/config.json' }) });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\x1b/);
});

for(const payload of ['{"ok":false}', '{invalid'])test(`Нулевой код init без подтверждения ${payload} возвращает прежний мост`,async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'package.json'),'{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    await fs.writeFile(path.join(f.env.INSTALL_DIR,'previous'),'keep');
    const result=f.run({TEST_INIT_RESULT:payload});assert.notEqual(result.status,0);assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR,'previous'),'utf8'),'keep');
    assert.doesNotMatch(result.stdout,/Готово!|Команда подключения готова/);assert.doesNotMatch(await fs.readFile(path.join(f.root,'events'),'utf8'),/--connect-open/);
});
test('Неподтверждённое снятие паузы не выдаётся за готовое подключение',async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'package.json'),'{"name":"neurocenter-asset-sync","version":"0.9.0"}');
    const result=f.run({TEST_FINISH_RESULT:'{"ok":false}'});assert.notEqual(result.status,0);assert.match(result.stderr,/не подтвердила снятие паузы/);assert.doesNotMatch(result.stdout,/Готово!/);
});
test('Старый архив без короткой команды не заменяет предыдущую установку',async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'previous'),'keep');
    await fs.rm(path.join(f.root,'package/dist/bridge-cli.js'));await f.pack();
    const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/опубликовать новую сборку/);assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR,'previous'),'utf8'),'keep');
});
for(const code of [60,28,22])test(`Сетевая ошибка ${code} понятна, установка и lock сохраняют инварианты`,async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'previous'),'keep');
    await fs.writeFile(path.join(f.root,'fake-bin/curl'),'#!/bin/sh\nprintf \'%s\\n\' "$*" > "$TEST_ROOT/curl-args"\nexit "$TEST_CURL_CODE"\n',{mode:0o755});
    const result=f.run({TEST_CURL_CODE:String(code)});assert.notEqual(result.status,0);assert.match(result.stderr,code===60?/CURL_CA_BUNDLE/:code===28?/вовремя/:/Не удалось скачать/);
    assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR,'previous'),'utf8'),'keep');
    await assert.rejects(fs.access(f.env.INSTALL_DIR+'.install-lock'),{code:'ENOENT'});
    assert.match(await fs.readFile(path.join(f.root,'curl-args'),'utf8'),/--connect-timeout 20 --max-time 600 --retry 2/);
});
test('API Gateway transport сохраняется отдельно от site identity',async()=>{
    const f=await fixture();const binary=path.join(f.root,'package/bin/node');await fs.writeFile(binary,(await fs.readFile(binary,'utf8')).replace('echo "$*" >> "$TEST_ROOT/events"','echo "$*" >> "$TEST_ROOT/events"\n        printf \'%s\\n\' "$NEUROCENTER_API_URL" >> "$TEST_ROOT/api-origins"'));await f.pack();
    const result=f.run({BASE_URL:'https://gateway.example.test/api/bridge',SITE_URL:'https://panel.example.test'});assert.equal(result.status,0,result.stderr);
    assert.ok((await fs.readFile(path.join(f.root,'api-origins'),'utf8')).trim().split('\n').every(line=>line==='https://gateway.example.test'));
});
test('Отказ распаковки сохраняет предыдущий мост и сообщает о свободном месте',async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'previous'),'keep');
    await fs.writeFile(path.join(f.root,'fake-bin/tar'),'#!/bin/sh\nif [ "$1" = -xzf ]; then echo "fixture-raw-error: no space left" >&2; exit 1; fi\nexec /usr/bin/tar "$@"\n',{mode:0o755});
    const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/свободное место/);assert.doesNotMatch(result.stderr,/fixture-raw-error/);assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR,'previous'),'utf8'),'keep');
    await assert.rejects(fs.access(f.env.INSTALL_DIR+'.install-lock'),{code:'ENOENT'});
});
test('SIGTERM во время init восстанавливает прежнюю версию, снимает паузу и свою блокировку',{timeout:15000},async()=>{
    const f=await fixture();await fs.mkdir(f.env.INSTALL_DIR);await fs.writeFile(path.join(f.env.INSTALL_DIR,'package.json'),'{"name":"neurocenter-asset-sync","version":"0.9.0"}');await fs.writeFile(path.join(f.env.INSTALL_DIR,'previous'),'keep');
    const gate=path.join(f.root,'cancel-gate');const child=spawn('bash',[f.scriptPath],{env:{...f.env,TEST_INIT_GATE:gate},stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',chunk=>errors+=chunk);
    const finished=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
    try {const deadline=Date.now()+8000;while(!await fs.access(gate+'.started').then(()=>true,()=>false)){assert.ok(Date.now()<deadline,errors);await new Promise(resolve=>setTimeout(resolve,20));}child.kill('SIGTERM');}
    finally {await fs.writeFile(gate+'.release','continue');}
    assert.notEqual(await finished,0);assert.equal(await fs.readFile(path.join(f.env.INSTALL_DIR,'previous'),'utf8'),'keep');await assert.rejects(fs.access(f.env.INSTALL_DIR+'.install-lock'),{code:'ENOENT'});
    assert.match(await fs.readFile(path.join(f.root,'events'),'utf8'),/--finish-upgrade/);
});
