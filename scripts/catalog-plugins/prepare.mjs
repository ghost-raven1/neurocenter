import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import { buildRecipe, inspectBuildOutput } from './build.mjs';
import {loadRepository,assetDigest,validateIndex} from '@neurocenter/asset-contract';
import { npmTools, filePlugins } from './generic.mjs';
import { additionalSourceTargets } from './source-adapters.mjs';
import { validateRecipe } from './recipe-schema.mjs';
import { RAG_REVISION } from './recipes/opencode-rag.mjs';
import { RAG_PLUGIN_REVISION } from './recipes/opencode-rag-plugin.mjs';
import { SNIP_VERSION, SNIP_PLUGIN_VERSION } from './recipes/opencode-snip.mjs';

/** Встроенный каталог задаёт только рецепты; упаковка совпадает с любым пользовательским расширением. */
export function builtinRecipes() {
    const tools = [
        ...npmTools.map(tool => ({ key: tool.key, name: tool.name, kind: 'mcp', description: tool.description, tags: tool.tags, revision: `${tool.version}-pack.1` })),
        ...filePlugins.map(tool => ({ key: tool.key, name: tool.name, kind: 'plugin', description: tool.description, tags: tool.tags, revision: `${tool.revision ?? '1.0.0'}-pack.1` })),
        { key: 'opencode-rag', name: 'OpenCodeRAG', kind: 'mcp', revision: RAG_REVISION, tags: ['RAG', 'npm', 'Локальная настройка'],
            description: 'Локальный поиск по смыслу, структура файлов и поиск использований из OpenCodeRAG. MCP с явным инструментом index_project и настоящим Web UI; модель и размерность подключаются в настройках проекта через мост. Без TUI и автоиндексации OpenCode V2. Intel Mac не поддерживается.' },
        { key: 'opencode-rag-plugin', name: 'OpenCodeRAG (плагин)', kind: 'plugin', revision: RAG_PLUGIN_REVISION, tags: ['RAG', 'GitHub', 'Автоиндексация'],
            description: 'Плагин MrDoe/OpenCodeRAG 2.4.4 из закреплённого GitHub commit: поиск, структура файлов, память, настоящий Web UI и hooks OpenCode 1. Модель и размерность подключаются в настройках проекта через мост; существующий opencode-rag.json сохраняется. Совместимая фабрика без V2/TUI. Intel Mac не поддерживается.' },
        { key: 'opencode-snip', name: 'opencode-snip', kind: 'plugin', revision: `${SNIP_PLUGIN_VERSION}+snip.${SNIP_VERSION}.pack.1`, tags: ['Терминал', 'GitHub Releases', 'Готовый комплект'],
            description: 'Сокращает вывод команд терминала через opencode-snip и встроенный snip CLI. Готовые бинарники из GitHub Releases, SHA-256 проверен; ручная установка CLI и изменение PATH не нужны. Сложные shell-команды остаются без изменений.' },
    ];
    return tools.map(tool => ({ schemaVersion: 1, ...tool, source: { type: 'prepared', adapter: tool.key } }));
}

/** Собирает несколько рецептов тем же API и проверяет общий manifest до любой публикации. */
export async function prepareCatalog({ output, only, targets, dryRun = false }) {
    const recipes = builtinRecipes();
    const known = new Set(recipes.map(recipe => recipe.key));
    if (!output || only !== undefined && (!Array.isArray(only) || !only.length || new Set(only).size !== only.length || only.some(key => !known.has(key)))
        || targets !== undefined && (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length || targets.some(target => !runtime.TARGETS.includes(target)))) {
        throw new Error('Укажите output, известные уникальные --only и --targets.');
    }
    const selected = recipes.filter(recipe => !only || only.includes(recipe.key)).map(recipe => validateRecipe({ ...recipe,
        targets: targets ?? additionalSourceTargets(recipe.source) ?? runtime.TARGETS }));
    const directory = await inspectBuildOutput(output);
    if (!dryRun) {
        await fs.mkdir(directory, { recursive: true });
        if ((await fs.readdir(directory)).length) {
            throw new Error('Папка поставки должна быть новой или пустой и не должна быть ссылкой.');
        }
    }
    const index={schemaVersion:1,assets:[]},plans=[];
    for(const recipe of selected){
        const temporary=path.join(directory,recipe.key);
        const result=await buildRecipe({recipe,recipePath:fileURLToPath(new URL(`./recipes/${recipe.key}.json`,import.meta.url)),output:temporary,dryRun});
        if(dryRun){plans.push(result);continue;}
        const bytes=await fs.readFile(result.manifest),asset=JSON.parse(bytes.toString('utf8'));
        const relative=`assets/${asset.id}/${asset.version}`,final=path.join(directory,relative);
        await fs.mkdir(path.dirname(final),{recursive:true});await fs.rename(temporary,final);
        index.assets.push({id:asset.id,kind:asset.kind,version:asset.version,path:relative+'/asset.json',sha256:assetDigest(bytes),current:true});
    }
    if(dryRun)return {ok:true,dryRun:true,plans};
    validateIndex(index);await fs.writeFile(path.join(directory,'index.json'),JSON.stringify(index,null,2)+'\n',{flag:'wx',mode:0o600});
    await loadRepository(directory);return index;
}

export function parsePrepareArguments(args) {
    const options = { dryRun: false };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (seen.has(argument)) { throw new Error('Параметр повторён.'); }
        seen.add(argument);
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        const field = { '--output': 'output', '--only': 'only', '--targets': 'targets' }[argument];
        if (!field || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error('Параметры: --output <новая папка> [--only key,key] [--targets target,target] [--dry-run].');
        }
        const value = args[++index];
        options[field] = field === 'output' ? value : value.split(',');
    }
    if (!options.output) { throw new Error('Укажите новую папку --output.'); }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.umask(0o077);
    const options = parsePrepareArguments(process.argv.slice(2));
    Promise.resolve().then(()=>prepareCatalog(options))
        .then(result=>console.log(JSON.stringify({ok:true,dryRun:options.dryRun,...(options.dryRun?{plans:result.plans}:{index:path.join(path.resolve(options.output),'index.json'),assets:result.assets})},null,2)))
        .catch(error=>{console.error(error instanceof Error?error.message:'Подготовка ассетов не выполнена.');process.exitCode=1;});
}
