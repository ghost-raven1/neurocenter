import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const workspacePackages = ['services/oauth2-bridge', 'services/catalog-service', 'services/feature-flags-service', 'services/skills-service',
    'services/rag-sync-service', 'services/api-gateway', 'frontend', 'mcp/neurocenter-asset-sync'];
const packageIds = new Map(workspacePackages.map(directory => [directory === 'mcp/neurocenter-asset-sync' ? 'bridge' : path.posix.basename(directory), directory]));
const packageSteps = ['typecheck', 'build', 'test'];

export const checkHelp = `Проверка workspace: node scripts/workspace/check.mjs [--package <id>]... [--step <шаг>]... | --tooling
Пакеты: ${[...packageIds.keys()].join(', ')}.
Шаги: ${packageSteps.join(', ')}.
Без селекторов выполняется полный план, включая общие контракты и Compose.
Селекторы ограничивают план только выбранными пакетами и шагами; test не запускает build автоматически.
--tooling: отдельный фиксированный локальный набор agent-kit/MCP/check/coverage без продуктовых шагов и Compose.
NEUROCENTER_CHECK_TOOLING=0 отключает исполнение --tooling; справка и чтение плана остаются доступны.
--help, -h: справка без запуска команд и создания отчёта.`;

/** Parse selectors before inspecting manifests, resolving tools or creating any output. */
export function parseCheckOptions(args) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
    if(args.includes('--tooling')){
        if(args.length!==1)throw new Error('Некорректное сочетание --tooling: используйте отдельно от других селекторов.');
        return {packages:[],steps:[],tooling:true};
    }
    const options = {packages: [], steps: []};
    for (let index = 0; index < args.length; index++) {
        const flag = args[index];
        if (!['--package', '--step'].includes(flag)) throw new Error('Неизвестный параметр check. Используйте --help отдельно.');
        const value = args[++index], allowed = flag === '--package' ? packageIds : new Set(packageSteps);
        if (!allowed.has(value)) throw new Error('Некорректное значение '+flag+'. Используйте --help.');
        const selected = flag === '--package' ? options.packages : options.steps;
        if (!selected.includes(value)) selected.push(value);
    }
    return options;
}

/** Общие контракты и builder входят в приёмку вместе с сервисами, каждый файл ровно один раз. */
export function nodeTestFiles(root, {readFile = name => fs.readFileSync(path.join(root,name),'utf8'),
    readDirectory = directory => fs.readdirSync(path.join(root,directory))} = {}) {
    return ['scripts/test', 'scripts/catalog-plugins/test', 'scripts/catalog-plugins/recipes/test', 'scripts/agent-kit/test'].flatMap(directory =>
        readDirectory(directory).filter(file => /\.(?:mjs|cjs)$/.test(file)
            && /(?:from\s*['"]node:test['"]|require\(['"]node:test['"]\))/.test(readFile(path.join(directory,file))))
            .map(file => path.join(directory, file))).sort();
}

/** Admit bounded reviewed local paths, reading the inventory and selected bytes through the planner cache. */
function toolingTestFiles(root,{readFile=name=>fs.readFileSync(path.join(root,name),'utf8')}={}){
    const list='scripts/workspace/check-tooling-tests.json',absolute=path.resolve(root);
    const invalid=()=>new Error('Некорректный фиксированный набор tooling: проверьте список и обычные файлы без ссылок.');
    if(fs.realpathSync(absolute)!==absolute)throw invalid();
    const inspect=(name,limit=1024**2)=>{
        let current=absolute;const parts=name.split('/');
        for(const [index,part]of parts.entries()){
            current=path.join(current,part);const stat=fs.lstatSync(current);
            if(stat.isSymbolicLink()||(index===parts.length-1?!stat.isFile()||stat.nlink!==1||stat.size>limit:!stat.isDirectory()))throw invalid();
        }
        return readFile(name);
    };
    const raw=inspect(list,16384);if(Buffer.byteLength(raw)>16384)throw invalid();
    const files=JSON.parse(raw);
    if(!Array.isArray(files)||!files.length||files.length>64||new Set(files).size!==files.length
        ||files.some(file=>typeof file!=='string'||file.length>180||!/^scripts\/(?:test|agent-kit\/test)\/[a-z0-9-]+\.test\.mjs$/.test(file)))throw invalid();
    inspect('scripts/agent-kit/generate.mjs');for(const file of files)inspect(file);
    return [...files].sort();
}

/** Полный план сохраняет порядок typecheck/build/test; селекторы задают точный ограниченный объём. */
export function checkPlan(root, options = {}, {readManifest = directory => JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8')),
    readTestFiles = () => nodeTestFiles(root),readToolingFiles = () => toolingTestFiles(root)} = {}) {
    const {packages = [], steps: selectedSteps = []} = options;
    if (Object.keys(options).some(key => !['packages', 'steps', 'tooling'].includes(key))
        || !Array.isArray(packages) || packages.some(id => !packageIds.has(id))
        || !Array.isArray(selectedSteps) || selectedSteps.some(step => !packageSteps.includes(step))
        || Object.hasOwn(options,'tooling')&&(options.tooling!==true||packages.length||selectedSteps.length)) throw new Error('Некорректные селекторы плана check.');
    if(options.tooling)return [
        {name:'Agent kit: актуальность генерации',directory:'.',type:'node',args:['scripts/agent-kit/generate.mjs','--check']},
        {name:'Инструменты разработки: локальные контракты',directory:'.',type:'node',nodeTests:true,args:['--test','--test-concurrency=1',...readToolingFiles()]},
    ];
    const selectedPackages = packages.length ? new Set(packages.map(id => packageIds.get(id))) : null;
    const scoped = packages.length > 0 || selectedSteps.length > 0, steps = [];
    if (!scoped) steps.push({name: 'Agent kit: актуальность генерации', directory: '.', type: 'node', args: ['scripts/agent-kit/generate.mjs', '--check']});
    for (const script of packageSteps.filter(step => !selectedSteps.length || selectedSteps.includes(step))) for (const directory of workspacePackages) {
        if (selectedPackages && !selectedPackages.has(directory)) continue;
        const manifest = readManifest(directory);
        if (script === 'test' && !manifest.scripts?.test) continue;
        steps.push({name: `${directory}: ${script}`, directory, type: 'npm', args: ['run', script], vitest: script === 'test' && /vitest/.test(manifest.scripts.test)});
    }
    if (scoped && !steps.length) throw new Error('Выбранные пакеты не содержат указанных шагов check.');
    if (!scoped) {
        steps.push({name: 'Общие контракты, production и упаковка', directory: '.', type: 'node', nodeTests: true, args: ['--test', '--test-concurrency=2', ...readTestFiles()]});
        steps.push({name: 'Compose: dev', directory: '.', type: 'compose', args: ['compose', 'config', '--no-env-resolution', '--quiet']});
        steps.push({name: 'Compose: локальные эмбеддинги', directory: '.', type: 'compose', args: ['compose', '-f', 'compose.embedding.yml', 'config', '--quiet']});
    }
    return steps;
}

/** Capture the exact manifest and test-discovery bytes used to admit a plan. */
export function captureCheckPlan(root,options,{readFileBytes=name=>fs.readFileSync(path.join(root,name)),
    readDirectory=directory=>fs.readdirSync(path.join(root,directory))}={}){
    const files=new Map(),inputs={};
    const readFile=name=>{
        if(!files.has(name)){const bytes=readFileBytes(name);files.set(name,bytes.toString('utf8'));inputs[name]=createHash('sha256').update(bytes).digest('hex');}
        return files.get(name);
    };
    const steps=checkPlan(root,options,{readManifest:directory=>JSON.parse(readFile(path.join(directory,'package.json'))),readTestFiles:()=>nodeTestFiles(root,{readFile,readDirectory}),
        readToolingFiles:()=>toolingTestFiles(root,{readFile})});
    return {steps,inputs};
}
