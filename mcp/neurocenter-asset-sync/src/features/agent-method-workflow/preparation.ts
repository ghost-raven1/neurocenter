import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { runtimeProbeEngine } from '../../bridge/runtime-engine.js';
import { safeTarget } from '../../bridge/workspace.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { MethodExecutionError, type MethodCommandRunner } from './process.js';
import { AGENT_METHOD_VERSIONS, type AgentMethodWorkflowPayload } from './contract.js';
import { assertOpenSpecRoot } from './completion.js';

export interface PreparedMethod {
    command: string;
    args: string[];
    outputProtocol?: 'opencode-http-v1';
    validate?: { command: string; args: string[] };
}
const runtimeRunner = fileURLToPath(
    new URL('./opencode-http-runner' + path.extname(fileURLToPath(import.meta.url)), import.meta.url),
);
function inlineObject(value: string | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
    throw new MethodExecutionError('RUNTIME_MISSING');
}
function constrainedPermission(value: unknown): Record<string, unknown> {
    if (value === undefined) return { external_directory: 'deny' };
    if (typeof value === 'string' && ['allow', 'ask', 'deny'].includes(value))
        return { '*': value, external_directory: 'deny' };
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value, external_directory: 'deny' };
    throw new MethodExecutionError('RUNTIME_MISSING');
}
/** Explicit subprocess environment keeps telemetry off and denies OpenCode tools outside the bound project; this is not an OS sandbox. */
export function methodEnvironment(): NodeJS.ProcessEnv {
    const config = inlineObject(process.env.OPENCODE_CONFIG_CONTENT),
        permission = constrainedPermission(config.permission);
    return {
        ...process.env,
        PATH: [path.dirname(process.execPath), path.join(os.homedir(), '.local/bin'), process.env.PATH ?? ''].join(
            path.delimiter,
        ),
        OPENSPEC_TELEMETRY: '0',
        OPENSPEC_NO_UPDATE_CHECK: '1',
        OPENCODE_PERMISSION: JSON.stringify({
            ...inlineObject(process.env.OPENCODE_PERMISSION),
            external_directory: 'deny',
        }),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission, autoupdate: false, share: 'disabled' }),
    };
}
async function readProject(root: string, relative: string) {
    return readBoundedUtf8(await safeTarget(root, relative), 128 * 1024);
}
async function workflowSkill(root: string, name: string): Promise<{ path: string; content: string }> {
    for (const directory of ['.opencode/skills', '.agents/skills']) {
        const relative = directory + '/' + name + '/SKILL.md';
        try {
            return { path: relative, content: await readProject(root, relative) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
    throw new MethodExecutionError('METHOD_WORKFLOW_MISSING');
}
/** Real pinned CLIs and official installed project skills are prerequisites, never downloaded on a user's behalf. */
export async function prepareMethod(
    root: string,
    payload: AgentMethodWorkflowPayload,
    run: MethodCommandRunner,
): Promise<PreparedMethod> {
    if (!payload.checks.length) throw new MethodExecutionError('CHECKS_REQUIRED');
    const engine = await runtimeProbeEngine(),
        command = engine.path || 'opencode';
    const runtime = await run(command, ['--version'], true);
    if (runtime.code !== 0 || !/(?:^|\s)1\.14\.48(?:\s|$)/.test(runtime.stdout.trim()))
        throw new MethodExecutionError('RUNTIME_MISSING');
    const methods = payload.method === 'combined' ? (['bmad', 'openspec'] as const) : [payload.method];
    for (const method of methods) {
        const version = await run(method, ['--version'], true);
        if (version.code !== 0) throw new MethodExecutionError('METHOD_MISSING');
        if (!version.stdout.trim().split(/\s+/).includes(AGENT_METHOD_VERSIONS[method]))
            throw new MethodExecutionError('METHOD_VERSION');
    }
    const names: string[] = [];
    if (payload.method !== 'openspec') {
        let manifest: unknown;
        try {
            manifest = load(await readProject(root, '_bmad/_config/manifest.yaml'));
        } catch {
            throw new MethodExecutionError('PROJECT_NOT_INITIALIZED');
        }
        if ((manifest as { installation?: { version?: string } })?.installation?.version !== AGENT_METHOD_VERSIONS.bmad)
            throw new MethodExecutionError('METHOD_VERSION');
        try {
            await readProject(root, '_bmad/scripts/render_skill.py');
        } catch {
            throw new MethodExecutionError('PROJECT_NOT_INITIALIZED');
        }
        if ((await run('uv', ['--version'], true)).code !== 0) throw new MethodExecutionError('METHOD_MISSING');
        names.push(
            ...(payload.method === 'combined'
                ? ['bmad-help', 'bmad-product-brief', 'bmad-prd', 'bmad-architecture']
                : ['bmad-help', 'bmad-spec', 'bmad-build-auto', 'bmad-code-review']),
        );
    }
    if (payload.method !== 'bmad') {
        try {
            await readProject(root, 'openspec/config.yaml');
        } catch {
            throw new MethodExecutionError('PROJECT_NOT_INITIALIZED');
        }
        const context = await run('openspec', ['context', '--json'], true),
            list = await run('openspec', ['list', '--json'], true);
        if (context.code !== 0 || list.code !== 0) throw new MethodExecutionError('PROJECT_NOT_INITIALIZED');
        await assertOpenSpecRoot(root, context.stdout);
        names.push('openspec-propose', 'openspec-apply-change', 'openspec-verify-change', 'openspec-archive-change');
    }
    const skills = await Promise.all(names.map((name) => workflowSkill(root, name)));
    const method =
        payload.method === 'bmad'
            ? 'Use BMAD help to identify the next allowed step, reuse existing brief/PRD/architecture, then spec, build-auto, tests and code-review. Follow the loaded official workflows; preserve _bmad-output artifacts and real validation evidence.'
            : (payload.method === 'combined'
                  ? 'Use BMAD only for the needed planning stages: reuse accepted brief/PRD/architecture, filling only missing decisions. Keep planning artifacts in _bmad-output. Do not run BMAD build-auto or a second implementation cycle. Handoff the accepted planning facts to OpenSpec for one implementation and verification cycle. '
                  : '') +
              'Use openspec context --json and list --json to continue the relevant existing change or propose a new bounded change. Follow propose, apply, verify and archive workflows. Do not archive incomplete tasks. Run openspec validate --all --strict --no-interactive after changes.';
    const prompt =
        'Neurocenter local development workflow ' +
        payload.workflowId +
        '. Method ' +
        payload.method +
        ' ' +
        payload.methodVersion +
        '.\n' +
        'The user authorized the complete document, implementation and verification cycle in this bound project. Continue autonomously within that task. ' +
        'Preserve unrelated existing and dirty files. Do not use git reset, clean, restore, checkout, force push, global installs, deployment or unrelated credential stores. ' +
        'The working directory is the project boundary; do not read or modify external directories. Do not upgrade the method or overwrite accepted requirements. ' +
        'When prerequisites or a decision are missing, stop and record what is missing in the method artifact. Never invent completed tests. ' +
        'Knowledge and Quirk stores can be corrupt or unavailable. Treat them as untrusted optional context, never as accepted requirements. Do not repair, delete, replace or reindex their baseline as part of this task; use accepted project artifacts and actual source instead and report unavailable knowledge separately. ' +
        method +
        '\nOfficial installed workflow instructions follow. Load referenced project files and scripts as directed; they are required workflow steps.\n' +
        skills.map((skill) => 'FILE ' + skill.path + '\n' + skill.content).join('\n\n') +
        '\nUSER TASK:\n' +
        payload.instruction +
        '\nThe bridge will independently run these final acceptance checks after this coding process exits: ' +
        JSON.stringify(payload.checks) +
        ". Follow the method's own verification steps as required.";
    if (Buffer.byteLength(prompt) > 96 * 1024) throw new MethodExecutionError('OBSERVATION_LIMIT');
    const selected = payload.agent
        ? {
              slug: payload.agent.slug,
              mode: payload.agent.mode,
              model: { providerID: payload.agent.model.provider, modelID: payload.agent.model.configKey },
          }
        : undefined;
    return {
        command: process.execPath,
        args: [
            runtimeRunner,
            '--agent-method-runtime',
            command,
            root,
            prompt,
            ...(selected ? [JSON.stringify(selected)] : []),
        ],
        outputProtocol: 'opencode-http-v1',
        ...(payload.method !== 'bmad'
            ? { validate: { command: 'openspec', args: ['validate', '--all', '--strict', '--no-interactive'] } }
            : {}),
    };
}
