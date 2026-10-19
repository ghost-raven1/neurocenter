import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const scripts = fileURLToPath(new URL('../', import.meta.url));
let temporary = '', sequence = 0;

before(async () => {
    temporary = await mkdtemp(path.join(tmpdir(), 'nc-model-cli-'));
    const targets = Object.fromEntries([['embedding/config.mjs', 'config.mjs'], ['embedding/runtime.mjs', 'runtime.mjs'], ['vision/client.mjs', 'client.mjs']]
        .map(([source, fixture]) => [pathToFileURL(path.join(scripts, source)).href, pathToFileURL(path.join(temporary, fixture)).href]));
    const entries = ['embedding/cli.mjs', 'vision/cli.mjs'].map(file => pathToFileURL(path.join(scripts, file)).href);
    await writeFile(path.join(temporary, 'record.mjs'), "import {appendFileSync} from 'node:fs'; export function record(event,value={}){appendFileSync(process.env.MODEL_CLI_TEST_RECORD,JSON.stringify({event,...value})+'\\n');}");
    await writeFile(path.join(temporary, 'config.mjs'), `import {record} from './record.mjs';
        export function configuration(env=process.env,_root,profile='embedding') {
            record('configuration',{profile}); if(env.EMBEDDING_PORT==='invalid') throw Error('EMBEDDING_PORT: fixture invalid');
            return {capability:profile,baseUrl:'http://127.0.0.1:9999',lock:{model:'fixture-'+profile,dimension:profile==='embedding'?2560:undefined}};
        }`);
    await writeFile(path.join(temporary, 'runtime.mjs'), `import {record} from './record.mjs';
        const receipt=config=>({model:config.lock.model,dimension:config.lock.dimension,checkedAt:'2026-10-19T00:00:00.000Z'});
        export async function up(config,progress,probe) {
            record('up',{hasProbe:typeof probe==='function'}); if(process.env.MODEL_CLI_TEST_NON_ERROR) throw 'own fixture rejection';
            for(const value of [{status:'pulling',completed:7,total:100},{status:'pulling',completed:7,total:100},{status:'success'}]) progress(value);
            if(probe) await probe(config); return receipt(config);
        }
        export async function check(config,probe) {record('check',{hasProbe:typeof probe==='function'});if(probe)await probe(config);return receipt(config);}
        export async function status(config) {record('status');return {...receipt(config),state:process.env.MODEL_CLI_TEST_STATE||'verified'};}
        export async function compose(_config,args,options) {record('compose',{args,options});}
        export async function withControlLock(_config,action) {record('lock');return action();}`);
    await writeFile(path.join(temporary, 'client.mjs'), "import {record} from './record.mjs';export async function probeVision(){record('probeVision');return {visionVerified:true};}");
    await writeFile(path.join(temporary, 'tripwire.mjs'), "export function spawn(){throw Error('REAL_DOCKER_FORBIDDEN');}export function spawnSync(){throw Error('REAL_DOCKER_FORBIDDEN');}export function execFile(){throw Error('REAL_DOCKER_FORBIDDEN');}");
    await writeFile(path.join(temporary, 'hook.mjs'), `import {registerHooks} from 'node:module';
        const targets=${JSON.stringify(targets)},entries=new Set(${JSON.stringify(entries)});
        globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
        registerHooks({resolve(specifier,context,next) {
            if(specifier==='node:child_process')return {url:new URL('./tripwire.mjs',import.meta.url).href,shortCircuit:true};
            const found=next(specifier,context);if(targets[found.url])return {...found,url:targets[found.url],shortCircuit:true};
            if((found.url.startsWith(${JSON.stringify(pathToFileURL(path.join(scripts, 'embedding/')).href)})
                ||found.url.startsWith(${JSON.stringify(pathToFileURL(path.join(scripts, 'vision/')).href)}))&&!entries.has(found.url))throw Error('UNEXPECTED_REAL_MODEL_MODULE');
            return found;
        }});`);
});
after(async () => {if (temporary) await rm(temporary, {recursive: true, force: true});});

async function invoke(profile, args, env = {}, importOnly = false, file = path.join(scripts, profile, 'cli.mjs')) {
    const record = path.join(temporary, `events-${++sequence}.jsonl`);
    const command = importOnly ? ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)})`] : [file, ...args];
    const result = spawnSync(process.execPath, ['--import', path.join(temporary, 'hook.mjs'), ...command],
        {encoding: 'utf8', timeout: 10000, env: {...process.env, MODEL_CLI_TEST_RECORD: record, ...env}});
    assert.equal(result.error, undefined);
    assert.doesNotMatch(result.stderr, /REAL_DOCKER_FORBIDDEN|REAL_NETWORK_FORBIDDEN|UNEXPECTED_REAL_MODEL_MODULE/);
    const events = await readFile(record, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse), error => {
        if (error.code === 'ENOENT') return []; throw error;
    });
    return {...result, events};
}

for (const profile of ['embedding', 'vision']) {
    test(`${profile}: справка и command --help не читают конфигурацию и не выполняют действие`, async () => {
        for (const args of [['--help'], ['-h'], ['—help'], ['up', '--help'], ['check', '--help'], ['status', '--help'], ['down', '--help'], ['down', '-h'],
            ['up', '—help'], ['check', '—help'], ['status', '—help'], ['down', '—help']]) {
            const result = await invoke(profile, args, {EMBEDDING_PORT: 'invalid'});
            assert.equal(result.status, 0, args.join(' ')); assert.match(result.stdout, new RegExp(`${profile}:up`));
            assert.match(result.stdout, /общий|Общий/); assert.equal(result.stderr, ''); assert.deepEqual(result.events, []);
        }
    });

    test(`${profile}: неизвестные и лишние аргументы отклоняются до конфигурации`, async () => {
        for (const args of [[], ['unknown'], ['down', '--unknown'], ['down', 'extra'], ['up', '--unexpected'], ['down', '--help', 'extra'], ['unknown', '--help'],
            ['down', '—help', 'extra'], ['unknown', '—help']]) {
            const result = await invoke(profile, args, {EMBEDDING_PORT: 'invalid'});
            assert.equal(result.status, 1); assert.match(result.stderr, /Использование|Справка/);
            assert.equal(result.stdout, ''); assert.deepEqual(result.events, []);
        }
    });

    test(`${profile}: импорт entrypoint не запускает CLI и не пишет в терминал`, async () => {
        const result = await invoke(profile, [], {}, true);
        assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.deepEqual(result.events, []);
    });

    test(`${profile}: entrypoint через symlink выполняет CLI, а импорт ссылки остаётся молчаливым`, {skip:process.platform === 'win32'}, async () => {
        const alias = path.join(temporary, `${profile}-cli.mjs`);
        await symlink(path.join(scripts, profile, 'cli.mjs'), alias);
        const help = await invoke(profile, ['--help'], {EMBEDDING_PORT: 'invalid'}, false, alias);
        assert.equal(help.status, 0); assert.match(help.stdout, new RegExp(`${profile}:up`));
        assert.equal(help.stderr, ''); assert.deepEqual(help.events, []);
        const status = await invoke(profile, ['status'], {}, false, alias);
        assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).state, 'verified');
        assert.deepEqual(status.events.map(event => event.event), ['configuration', 'status']);
        const imported = await invoke(profile, [], {}, true, alias);
        assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, ''); assert.deepEqual(imported.events, []);
    });

    test(`${profile}: up сохраняет профиль, правильную пробу и компактный прогресс`, async () => {
        const result = await invoke(profile, ['up']); assert.equal(result.status, 0);
        assert.equal(result.events[0].profile, profile);
        assert.equal(result.events.find(event => event.event === 'up').hasProbe, profile === 'vision');
        assert.equal(result.events.some(event => event.event === 'probeVision'), profile === 'vision');
        assert.equal(result.stdout.match(/pulling — 5%/g)?.length, 1);
        assert.match(result.stdout, profile === 'vision' ? /Число и цвет/ : /2560 измерений/);
    });

    test(`${profile}: check выполняется под блокировкой и сохраняет проверку своей модальности`, async () => {
        const result = await invoke(profile, ['check']); assert.equal(result.status, 0);
        assert.deepEqual(result.events.map(event => event.event), ['configuration', 'lock', 'check', ...(profile === 'vision' ? ['probeVision'] : [])]);
        assert.equal(result.events.find(event => event.event === 'check').hasProbe, profile === 'vision');
        assert.match(result.stdout, profile === 'vision' ? /Проверка картинки пройдена/ : /2560 измерений/);
    });

    test(`${profile}: down явно останавливает общий хостинг под блокировкой`, async () => {
        const result = await invoke(profile, ['down']); assert.equal(result.status, 0);
        assert.deepEqual(result.events.map(event => event.event), ['configuration', 'lock', 'compose']);
        assert.deepEqual(result.events.at(-1), {event: 'compose', args: ['down'], options: {inherit: true}});
        assert.match(result.stdout, /Общий хостинг/); assert.match(result.stdout, /embedding/); assert.match(result.stdout, /vision/);
    });

    test(`${profile}: status не выполняет пробу, непройденная готовность возвращает код 1`, async () => {
        for (const state of ['verified', 'unchecked', 'missing']) {
            const result = await invoke(profile, ['status'], {MODEL_CLI_TEST_STATE: state});
            assert.equal(result.status, state === 'verified' ? 0 : 1); assert.equal(JSON.parse(result.stdout).state, state);
            assert.deepEqual(result.events.map(event => event.event), ['configuration', 'status']);
        }
    });

    test(`${profile}: ошибки конфигурации возвращаются без обращения к runtime`, async () => {
        const result = await invoke(profile, ['up'], {EMBEDDING_PORT: 'invalid'});
        assert.equal(result.status, 1); assert.match(result.stderr, /EMBEDDING_PORT: fixture invalid/);
        assert.deepEqual(result.events.map(event => event.event), ['configuration']);
    });

    test(`${profile}: отклонение без объекта Error даёт понятное сообщение без undefined и стека`, async () => {
        const result = await invoke(profile, ['up'], {MODEL_CLI_TEST_NON_ERROR: '1'});
        assert.equal(result.status, 1); assert.match(result.stderr, /Не удалось/); assert.doesNotMatch(result.stderr, /undefined|\n\s+at /);
    });
}
