import fs from 'node:fs/promises';
import { load } from 'js-yaml';
import { safeTarget } from '../../bridge/workspace.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { MethodExecutionError, type MethodCommandRunner } from './process.js';
import type { AgentMethodWorkflowPayload, AgentMethodWorkflowResult } from './contract.js';

const incomplete = () => new MethodExecutionError('EXECUTION_FAILED');
const read = async (root: string, file: string) => readBoundedUtf8(await safeTarget(root, file), 256 * 1024);
/** A planning-only exit or an unchanged old artifact is never accepted as a completed development cycle. */
export async function assertMethodCompleted(
    root: string,
    payload: AgentMethodWorkflowPayload,
    result: AgentMethodWorkflowResult,
    run: MethodCommandRunner,
): Promise<void> {
    const changed = result.changes.filter((file) => file.afterSha256 !== null);
    if (payload.method === 'combined') {
        const planning = result.artifacts.filter(
            (file) =>
                file.path.startsWith('_bmad-output/') && /(?:brief|prd|architecture|spec)[^/]*\.md$/i.test(file.path),
        );
        let accepted = false;
        for (const file of planning) {
            const content = await read(root, file.path),
                frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
            const state = frontmatter ? (load(frontmatter[1]!) as { status?: string })?.status : undefined;
            if (content.trim() && !['draft', 'blocked', 'in-progress', 'pending'].includes(state ?? ''))
                accepted = true;
        }
        if (!accepted) throw incomplete();
    }
    if (payload.method === 'bmad') {
        for (const file of changed.filter(
            (file) => file.path.startsWith('_bmad-output/') && file.path.endsWith('.md'),
        )) {
            const content = await read(root, file.path),
                frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
            const status = frontmatter ? (load(frontmatter[1]!) as { status?: string })?.status : undefined;
            if (
                status === 'done' &&
                !/^\s*- \[ \]/m.test(content) &&
                /^## Auto Run Result\s*$/m.test(content) &&
                /^## Review Triage Log\s*$/m.test(content)
            )
                return;
        }
        throw incomplete();
    }
    const names = new Set(
        changed
            .map((file) => /^openspec\/changes\/(archive\/[^/]+|[^/]+)\//.exec(file.path)?.[1])
            .filter((value): value is string => !!value && value !== 'archive'),
    );
    const existing: string[] = [];
    for (const name of names) {
        try {
            await read(root, 'openspec/changes/' + name + '/tasks.md');
            existing.push(name);
        } catch {}
    }
    if (existing.length !== 1) throw incomplete();
    const name = existing[0]!,
        directory = 'openspec/changes/' + name;
    const tasks = await read(root, directory + '/tasks.md');
    if (!/^\s*- \[[xX]\]/m.test(tasks) || /^\s*- \[ \]/m.test(tasks)) throw incomplete();
    if (name.startsWith('archive/')) {
        await read(root, directory + '/proposal.md');
        if (
            !result.artifacts.some(
                (file) => file.path.startsWith(directory + '/specs/') && file.path.endsWith('/spec.md'),
            )
        )
            throw incomplete();
        return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw incomplete();
    const response = await run('openspec', ['instructions', 'apply', '--change', name, '--json'], true);
    if (response.code !== 0) throw incomplete();
    let state: {
        state?: string;
        changeDir?: string;
        progress?: { total?: number; complete?: number; remaining?: number };
        tasks?: Array<{ done?: boolean }>;
    };
    try {
        state = JSON.parse(response.stdout);
    } catch {
        throw incomplete();
    }
    if (
        state.state !== 'all_done' ||
        !state.progress?.total ||
        state.progress.complete !== state.progress.total ||
        state.progress.remaining !== 0 ||
        !state.tasks?.length ||
        state.tasks.some((task) => task.done !== true) ||
        typeof state.changeDir !== 'string' ||
        (await fs.realpath(state.changeDir)) !== (await fs.realpath(await safeTarget(root, directory)))
    )
        throw incomplete();
}

/** CLI stores outside this project are unsupported here; preserve them and request setup instead of silently creating another root. */
export async function assertOpenSpecRoot(root: string, stdout: string): Promise<void> {
    try {
        const context = JSON.parse(stdout) as { root?: { path?: string } };
        if (
            typeof context.root?.path !== 'string' ||
            (await fs.realpath(context.root.path)) !== (await fs.realpath(root))
        )
            throw incomplete();
    } catch {
        throw new MethodExecutionError('PROJECT_NOT_INITIALIZED');
    }
}
