#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { readyManifest } from './manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = path.join(root, 'services/catalog-service');

export function parseArguments(args) {
    const options = { baseUrl: 'http://localhost:5173', dryRun: false };
    const fields = { '--asset': 'asset', '--base-url': 'baseUrl', '--cookie-file': 'cookieFile' };
    const seen = new Set();
    for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (seen.has(argument)) { throw new Error('Параметр повторён.'); }
        seen.add(argument);
        if (argument === '--dry-run') { options.dryRun = true; continue; }
        const field = Object.hasOwn(fields,argument)?fields[argument]:undefined;
        if (!field || !args[index + 1] || args[index + 1].startsWith('--')) { throw new Error('Параметры: --asset <asset.json> [--dry-run] [--base-url <local URL>] [--cookie-file <файл>].'); }
        options[field] = args[++index];
    }
    if (!options.asset) { throw new Error('Укажите --asset <asset.json>.'); }
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.pathname !== '/' || url.search || url.hash) { throw new Error('Этот помощник публикует в локальный dev-стек. Для production используйте операторский импорт готовых комплектов.'); }
    options.baseUrl = url.origin;
    return options;
}

/** parseEnv появился в Node 22.3; ленивая загрузка, чтобы импорт модуля не ломал старую версию. */
let parseEnvModule;
async function parseEnvText(text) {
    const { parseEnv } = parseEnvModule ??= await import('node:util');
    return parseEnv(text);
}

/** Как dev.mjs: process.env важнее .env.local, а локальные тома остаются внутри checkout. */
async function operatorEnvironment() {
    const fromFiles = {};
    for (const file of ['.env', '.env.local']) {
        try { Object.assign(fromFiles, await parseEnvText(await readFile(path.join(root, file), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    const env = { ...fromFiles, ...process.env };
    return { ...env, ...(!env.CATALOG_PG_URL_FILE?{CATALOG_PG_URL:env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'}:{}),
        RUNTIME_ARTIFACT_DIR: path.resolve(root, env.RUNTIME_ARTIFACT_DIR || 'data/runtime-artifacts') };
}

async function administrativeSession(options, env) {
    let cookie = options.cookieFile ? (await readFile(options.cookieFile, 'utf8')).trim().replace(/^Cookie:\s*/i, '') : '';
    if (cookie.length > 8192 || /[\x00-\x1f\x7f]/.test(cookie)) { throw new Error('Некорректный файл cookie.'); }
    const request = (route, init = {}) => fetch(options.baseUrl + route, { ...init, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-Neurocenter-Request': '1', ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(30_000) });
    let profile = await request('/auth/me');
    let ownSession = false;
    if (profile.status === 401 && !options.cookieFile && env.SSO_DISABLE === 'true' && env.NODE_ENV !== 'production') {
        const login = await request('/auth/login');
        const target = new URL(login.headers.get('location') || '/', options.baseUrl);
        const session = login.headers.getSetCookie().find(value => value.startsWith('bridge_session='));
        if (target.origin !== options.baseUrl || !session) { throw new Error('Стек требует SSO. Передайте действующую административную сессию через --cookie-file.'); }
        cookie = session.split(';')[0]; ownSession = true;
        profile = await request('/auth/me');
    }
    const close = async () => { if (ownSession) { await request('/auth/logout', { method: 'POST' }).catch(() => undefined); } };
    try {
        if (!profile.ok) { throw new Error('Нужна действующая сессия главного администратора; передайте --cookie-file.'); }
        const { user } = await profile.json();
        if (user?.activeRole !== 'Главный админ' || !user.userRoles?.includes('Главный админ')) { throw new Error('Выберите активную роль «Главный админ» для публикации каталога.'); }
        return { request, close };
    } catch (error) { await close(); throw error; }
}

async function importArtifact(artifact, env) {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'neurocenter-plugin-import-'));
    try {
        const descriptor = path.join(temporary, 'descriptor.json');
        await writeFile(descriptor, JSON.stringify(artifact.descriptor), { mode: 0o600, flag: 'wx' });
        await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [path.join(catalog, 'dist/runtime-artifacts/import.cli.js'), artifact.archivePath, descriptor],
                { cwd: catalog, env, stdio: ['ignore', 'ignore', 'pipe'] });
            let errorOutput = '';
            child.stderr.on('data', chunk => { if (errorOutput.length < 4096) { errorOutput += chunk.toString(); } });
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error('Импорт готового комплекта не выполнен: ' + errorOutput.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500))));
        });
    } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function retainSourceFiles(tool,env){
    if(!tool.retainedFiles.length)return;
    await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[path.join(root,'scripts/catalog-plugins/retain-supply.mjs'),tool.filename,tool.publication.publicationKey],{cwd:root,env,stdio:['ignore','ignore','pipe']});
        child.stderr.resume();child.once('error',()=>reject(new Error('Не удалось подготовить файлы исходника и рецепта.')));child.once('exit',code=>code===0?resolve():reject(new Error('Точные файлы исходника или рецепта не удержаны. Публикация карточки остановлена.')));
    });
}

/** Dry-run не создаёт сессию, файлы тома или записи БД. Повтор публикации использует тот же ключ. */
export async function publishCatalog(options) {
    const tools = await readyManifest(options.asset);
    if (options.dryRun) { return { ok: true, dryRun: true, tools: tools.map(tool => ({ key: tool.key, name: tool.publication.name,
        kind: tool.publication.kind, revision: tool.publication.revision, publicationKey: tool.publication.publicationKey,
        targets: tool.artifacts.map(artifact => artifact.descriptor.target) })) }; }
    const env = await operatorEnvironment();
    const session = await administrativeSession(options, env);
    try {
        const published = [];
        for (const tool of tools) {
            for (const artifact of tool.artifacts) { await importArtifact(artifact, env); }
            await retainSourceFiles(tool,env);
            const response = await session.request('/api/tool-builds/imports',{method:'POST',body:JSON.stringify({requestKey:tool.publication.publicationKey,asset:tool.asset})});
            if (!response.ok) { throw new Error(`${tool.key}: публикация отклонена (HTTP ${response.status}). Повторите тот же manifest после исправления причины.`); }
            const saved = await response.json();
            published.push({ key: tool.key, id: saved.catalogId, name: saved.name, version: saved.version, assetId:saved.assetId,sourceVersion:saved.sourceVersion,sourceSha256:saved.sourceSha256 });
        }
        return { ok: true, dryRun: false, tools: published };
    } finally { await session.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.umask(0o077);
    Promise.resolve().then(() => publishCatalog(parseArguments(process.argv.slice(2))))
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(error => { console.error(error instanceof Error ? error.message : 'Публикация не выполнена.'); process.exitCode = 1; });
}
