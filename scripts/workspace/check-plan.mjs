import fs from 'node:fs';
import path from 'node:path';

export const workspacePackages = ['services/oauth2-bridge', 'services/catalog-service', 'services/feature-flags-service', 'services/skills-service',
    'services/rag-sync-service', 'services/api-gateway', 'frontend', 'mcp/neurocenter-asset-sync'];
const packageIds = new Map(workspacePackages.map(directory => [directory === 'mcp/neurocenter-asset-sync' ? 'bridge' : path.posix.basename(directory), directory]));
const packageSteps = ['typecheck', 'build', 'test'];

export const checkHelp = `Проверка workspace: node scripts/workspace/check.mjs [--package <id>]... [--step <шаг>]...
Пакеты: ${[...packageIds.keys()].join(', ')}.
Шаги: ${packageSteps.join(', ')}.
Без селекторов выполняется полный план, включая общие контракты и Compose.
Селекторы ограничивают план только выбранными пакетами и шагами; test не запускает build автоматически.
--help, -h: справка без запуска команд и создания отчёта.`;

/** Parse selectors before inspecting manifests, resolving tools or creating any output. */
export function parseCheckOptions(args) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {help: true};
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
export function nodeTestFiles(root) {
    return ['scripts/test', 'scripts/catalog-plugins/test', 'scripts/catalog-plugins/recipes/test', 'scripts/agent-kit/test'].flatMap(directory =>
        fs.readdirSync(path.join(root, directory)).filter(file => /\.(?:mjs|cjs)$/.test(file)
            && /(?:from\s*['"]node:test['"]|require\(['"]node:test['"]\))/.test(fs.readFileSync(path.join(root, directory, file), 'utf8')))
            .map(file => path.join(directory, file))).sort();
}

/** Полный план сохраняет порядок typecheck/build/test; селекторы задают точный ограниченный объём. */
export function checkPlan(root, options = {}) {
    const {packages = [], steps: selectedSteps = []} = options;
    if (Object.keys(options).some(key => !['packages', 'steps'].includes(key))
        || !Array.isArray(packages) || packages.some(id => !packageIds.has(id))
        || !Array.isArray(selectedSteps) || selectedSteps.some(step => !packageSteps.includes(step))) throw new Error('Некорректные селекторы плана check.');
    const selectedPackages = packages.length ? new Set(packages.map(id => packageIds.get(id))) : null;
    const scoped = packages.length > 0 || selectedSteps.length > 0, steps = [];
    for (const script of packageSteps.filter(step => !selectedSteps.length || selectedSteps.includes(step))) for (const directory of workspacePackages) {
        if (selectedPackages && !selectedPackages.has(directory)) continue;
        const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
        if (script === 'test' && !manifest.scripts?.test) continue;
        steps.push({name: `${directory}: ${script}`, directory, type: 'npm', args: ['run', script], vitest: script === 'test' && /vitest/.test(manifest.scripts.test)});
    }
    if (scoped && !steps.length) throw new Error('Выбранные пакеты не содержат указанных шагов check.');
    if (!scoped) {
        steps.push({name: 'Общие контракты, production и упаковка', directory: '.', type: 'node', args: ['--test', '--test-concurrency=2', ...nodeTestFiles(root)]});
        steps.push({name: 'Compose: dev', directory: '.', type: 'compose', args: ['compose', 'config', '--no-env-resolution', '--quiet']});
        steps.push({name: 'Compose: локальные эмбеддинги', directory: '.', type: 'compose', args: ['compose', '-f', 'compose.embedding.yml', 'config', '--quiet']});
    }
    return steps;
}
