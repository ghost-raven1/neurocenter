#!/usr/bin/env node
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBuildOutput } from './build.mjs';
import { readyManifest } from './manifest.mjs';

const repository = 'https://github.com/ghost-raven1/neurocenter';
const npmPackages = {
    filesystem: '@modelcontextprotocol/server-filesystem', memory: '@modelcontextprotocol/server-memory',
    'sequential-thinking': '@modelcontextprotocol/server-sequential-thinking',
    'opencode-rag': 'opencode-rag-plugin', 'opencode-rag-plugin': 'opencode-rag-plugin', 'opencode-snip': 'opencode-snip',
};
const sources = {
    'opencode-rag': ['https://github.com/MrDoe/OpenCodeRAG'],
    'opencode-rag-plugin': ['https://github.com/MrDoe/OpenCodeRAG'],
    'opencode-snip': ['https://github.com/edouard-claude/snip'],
    'fetch-mcp': ['https://github.com/zcaceres/fetch-mcp'],
    'project-context': ['neurocenter:catalog-plugins'], 'git-context': ['neurocenter:catalog-plugins'],
};
const builtin = new Set([...Object.keys(npmPackages), ...Object.keys(sources)]);

function aliases(key, origin) {
    const pkg = npmPackages[key];
    return {
        legacyOrigins: [...new Set([origin, ...(builtin.has(key) ? [`neurocenter:recipe/${key}`] : []),
            ...(sources[key] ?? []), ...(pkg ? [`https://www.npmjs.com/package/${pkg}`, `npm:${pkg}`] : [])].filter(Boolean))],
        ...(pkg ? { legacyPackages: [pkg] } : {}),
    };
}

async function sha256(filename) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filename)) { hash.update(chunk); }
    return hash.digest('hex');
}

/** Проверяет всю поставку до записи; наружу выходят публичные метаданные и архивы по SHA-256. */
export async function exportCatalogRelease({ manifest, release, output, dryRun = false }) {
    if (typeof manifest !== 'string' || !manifest || typeof output !== 'string' || !output
        || typeof release !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(release)
        || /^(?:latest|main|master|head)$/.test(release) || typeof dryRun !== 'boolean') {
        throw new Error('Укажите manifest, новую output и закреплённый release (до 64 символов, без latest).');
    }
    const original = await fs.readFile(manifest);
    const validated = await readyManifest(manifest);
    if (!original.equals(await fs.readFile(manifest))) { throw new Error('Manifest изменился во время проверки. Повторите экспорт.'); }
    const input = JSON.parse(original.toString('utf8'));
    const directory = await inspectBuildOutput(output);
    const archives = new Map();
    const tools = validated.map((tool, index) => {
        const publication = input.tools[index].publication;
        return { key: tool.key, publication, ...aliases(tool.key, publication.origin),
            artifacts: tool.artifacts.map(artifact => {
                archives.set(artifact.descriptor.sha256, artifact);
                return { descriptor: artifact.descriptor,
                    url: `${repository}/releases/download/${release}/${artifact.descriptor.sha256}.tar.gz` };
            }) };
    });
    const result = { schemaVersion: 1, release, tools };
    const filename = path.join(directory, 'catalog-release.json');
    if (!dryRun) {
        await fs.mkdir(directory, { recursive: true });
        if ((await fs.readdir(directory)).length) { throw new Error('Папка output должна быть новой или пустой.'); }
        for (const [hash, artifact] of archives) {
            const destination = path.join(directory, `${hash}.tar.gz`);
            await fs.copyFile(artifact.archivePath, destination, constants.COPYFILE_EXCL);
            if (await sha256(destination) !== hash) { throw new Error('Архив изменился после проверки SHA-256. Публикация остановлена.'); }
        }
        // Manifest записывается последним: незавершённую поставку нельзя принять за готовую.
        await fs.writeFile(filename, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    }
    return { ok: true, dryRun, manifest: filename, release, archives: archives.size, tools: result.tools };
}

export function parseReleaseArguments(args) {
    const options = { dryRun: false }, seen = new Set();
    const fields = { '--manifest': 'manifest', '--release': 'release', '--output': 'output' };
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (seen.has(argument)) { throw new Error('Параметр повторён.'); }
        seen.add(argument);
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        if (!fields[argument] || !args[index + 1] || args[index + 1].startsWith('--')) {
            throw new Error('Параметры: --manifest <ready.json> --release <версия> --output <новая папка> [--dry-run].');
        }
        options[fields[argument]] = args[++index];
    }
    if (!options.manifest || !options.release || !options.output) { throw new Error('Укажите --manifest, --release и --output.'); }
    return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    Promise.resolve().then(() => exportCatalogRelease(parseReleaseArguments(process.argv.slice(2))))
        .then(({ tools, ...result }) => console.log(JSON.stringify({ ...result,
            tools: tools.map(tool => ({ key: tool.key, name: tool.publication.name, targets: tool.artifacts.map(item => item.descriptor.target) })) }, null, 2)))
        .catch(error => { console.error(error instanceof Error ? error.message : 'Экспорт каталога не выполнен.'); process.exitCode = 1; });
}
