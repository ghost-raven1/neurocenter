import fs from 'node:fs';
import path from 'node:path';

export const workspacePackages = ['services/oauth2-bridge', 'services/catalog-service', 'services/skills-service',
    'services/rag-sync-service', 'services/api-gateway', 'frontend', 'mcp/neurocenter-asset-sync'];

/** Общие контракты и builder входят в приёмку вместе с сервисами, каждый файл ровно один раз. */
export function nodeTestFiles(root) {
    return ['scripts/test', 'scripts/catalog-plugins/test', 'scripts/catalog-plugins/recipes/test'].flatMap(directory =>
        fs.readdirSync(path.join(root, directory)).filter(file => /\.(?:mjs|cjs)$/.test(file)
            && /(?:from\s*['"]node:test['"]|require\(['"]node:test['"]\))/.test(fs.readFileSync(path.join(root, directory, file), 'utf8')))
            .map(file => path.join(directory, file))).sort();
}

/** Сначала проверяются типы и свежая сборка; сценарии не читают устаревший dist. */
export function checkPlan(root) {
    const steps = [];
    for (const script of ['typecheck', 'build', 'test']) for (const directory of workspacePackages) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8'));
        if (script === 'test' && !manifest.scripts?.test) continue;
        steps.push({name: `${directory}: ${script}`, directory, type: 'npm', args: ['run', script], vitest: script === 'test' && /vitest/.test(manifest.scripts.test)});
    }
    steps.push({name: 'Общие контракты, production и упаковка', directory: '.', type: 'node', args: ['--test', '--test-concurrency=2', ...nodeTestFiles(root)]});
    steps.push({name: 'Compose: dev', directory: '.', type: 'compose', args: ['compose', 'config', '--quiet']});
    steps.push({name: 'Compose: локальные эмбеддинги', directory: '.', type: 'compose', args: ['compose', '-f', 'compose.embedding.yml', 'config', '--quiet']});
    return steps;
}
