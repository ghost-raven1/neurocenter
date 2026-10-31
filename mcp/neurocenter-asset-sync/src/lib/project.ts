import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Идентификация проекта (без авторитетного ключа без явного projectKey).
 */
export interface IProjectInfo {
    projectKey: string | null;
    projectSlug: string | null;
    gitRemote: string | null;
    gitBranch: string | null;
    packageName: string | null;
    hasAgentsMd: boolean;
    root: string;
    sources: string[];
    confidence: 'high' | 'medium' | 'low';
    note: string;
}

function pickCloneUrl(remote: string): string {
    // Берём first origin line (fetch) — он несёт URL.
    return remote.split('\n')[0]?.trim() ?? '';
}

function slugFromRemote(remote: string): string | null {
    // Извлекает последний сегмент пути репозитория (без .git).
    const m = remote.match(/[:/]([^/:]+)\.git$/);
    return m && m[1] ? m[1] : null;
}

function slugFromPackage(name: string): string {
    // scope/name → name.
    const i = name.lastIndexOf('/');
    return i >= 0 ? String(name.slice(i + 1)) : name;
}

/**
 * Определяет проект по workspace-root: git remote/branch, package.json,
 * AGENTS.md. `projectKey` поднимается в `high`, если передан явно.
 *
 * @param root - корень воркспейса (абсолютный).
 * @param projectKey - авторитетный ключ (опционально, от каталога/клиента).
 */
export async function detectProject(root: string, projectKey?: string): Promise<IProjectInfo> {
    const sources: string[] = [];
    let gitRemote: string | null = null;
    let gitBranch: string | null = null;
    let packageName: string | null = null;
    let hasAgentsMd = false;

    const git = await runGit(root, 'remote', '-v').catch(() => '');
    if (git) {
        gitRemote = pickCloneUrl(git);
        sources.push('git-remote');
    }
    const branch = await runGit(root, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '');
    if (branch) {
        gitBranch = branch;
        sources.push('git-branch');
    }

    try {
        const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
        const pj = JSON.parse(raw) as { name?: unknown };
        if (typeof pj.name === 'string' && pj.name) {
            packageName = pj.name;
            sources.push('package.json');
        }
    } catch {
        // нет package.json в корне — ок.
    }

    try {
        await fs.access(path.join(root, 'AGENTS.md'));
        hasAgentsMd = true;
        sources.push('AGENTS.md');
    } catch {
        // не критично.
    }

    const slug =
        (packageName && slugFromPackage(packageName)) || slugFromRemote(gitRemote ?? '') || path.basename(root) || null;

    let confidence: IProjectInfo['confidence'];
    if (projectKey) {
        confidence = 'high';
    } else if (gitRemote || packageName) {
        confidence = 'medium';
    } else {
        confidence = 'low';
    }

    let note: string;
    if (projectKey) {
        note = 'projectKey задан явно (authoritative).';
    } else if (confidence === 'low') {
        note =
            'git/package.json отсуствуют — projectKey не определился; передайте projectKey явно для точной привязки.';
    } else {
        note = 'определено по git/package.json; projectKey уточнить явно для привязки к серверу.';
    }

    return {
        projectKey: projectKey ?? null,
        projectSlug: slug,
        gitRemote,
        gitBranch,
        packageName,
        hasAgentsMd,
        root,
        sources,
        confidence,
        note,
    };
}

/**
 * Тонкая обёртка над `git -C <cwd> ...` (best-effort, пустая строка при ошибке).
 */
async function runGit(cwd: string, ...args: string[]): Promise<string> {
    return new Promise<string>((resolve) => {
        execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => {
            if (err) {
                resolve('');
                return;
            }
            resolve((stdout ?? '').trim());
        });
    });
}
