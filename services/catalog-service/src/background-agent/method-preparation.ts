import { readFile, realpath } from 'node:fs/promises';
import { load } from 'js-yaml';
import { AGENT_METHOD_VERSIONS } from '../../../shared/agent-method-workflow.cjs';
import type { TBackgroundAgentMethod } from '../../../shared/background-agent.cjs';

/**
 * FR-308 main-runtime BMAD→OpenSpec preparation (server side). This is the server port of the device
 * `prepareMethod` (mcp/.../agent-method-workflow/preparation.ts): the SAME pinned versions, the SAME
 * "no hidden updates / no install on send" contract, the SAME BMAD→OpenSpec combined prompt (reuse
 * accepted documents, one implementation cycle). It does not re-invent the device executor — it
 * reproduces the pinned-version and prompt semantics for the server background agent (entry 7).
 *
 * The pinned versions come from the single source AGENT_METHOD_VERSIONS. A mismatching installed
 * version is an EXPLICIT named error, never a silent substitution. The environment disables telemetry,
 * update checks and auto-update, so sending a task never downloads or installs anything.
 */
export const MAIN_RUNTIME_OPENCODE_VERSION = '1.14.48';

/** A pinned prerequisite is missing or the wrong version: an explicit, named failure (fail-closed). */
export class MainMethodPreparationError extends Error {
    readonly code:
        | 'RUNTIME_MISSING'
        | 'METHOD_MISSING'
        | 'METHOD_VERSION'
        | 'PROJECT_NOT_INITIALIZED'
        | 'METHOD_WORKFLOW_MISSING'
        | 'CHECKS_REQUIRED'
        | 'OBSERVATION_LIMIT';
    constructor(code: MainMethodPreparationError['code']) {
        super(code);
        this.code = code;
    }
}

/** Injected command runner (the seam): production runs the real pinned CLIs, tests stub the output. */
export type TMainMethodRunner = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const PROMPT_LIMIT = 96 * 1024;
const MANIFEST_LIMIT = 128 * 1024;

async function readProjectBounded(root: string, relative: string): Promise<string> {
    const raw = await readFile(`${root}/${relative}`);
    if (raw.byteLength > MANIFEST_LIMIT) throw new MainMethodPreparationError('OBSERVATION_LIMIT');
    return raw.toString('utf8');
}
function versionMatches(stdout: string, expected: string): boolean {
    return stdout.trim().split(/\s+/).includes(expected);
}
function inlineObject(value: string | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {}
    throw new MainMethodPreparationError('RUNTIME_MISSING');
}
function constrainedPermission(value: unknown): Record<string, unknown> {
    if (value === undefined) return { external_directory: 'deny' };
    if (typeof value === 'string' && ['allow', 'ask', 'deny'].includes(value))
        return { '*': value, external_directory: 'deny' };
    if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value, external_directory: 'deny' };
    throw new MainMethodPreparationError('RUNTIME_MISSING');
}

/**
 * The no-hidden-updates contract (FR-308): telemetry off, update checks off, auto-update off, share
 * disabled, external directories denied. Sending a task must never download or install anything.
 * A pre-existing valid OpenCode config is preserved (provider/model and other params) and the
 * no-update / no-external-directory constraints are layered on top of it, never replacing it.
 */
export function mainMethodEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const config = inlineObject(base.OPENCODE_CONFIG_CONTENT),
        permission = constrainedPermission(config.permission);
    return {
        ...base,
        OPENSPEC_TELEMETRY: '0',
        OPENSPEC_NO_UPDATE_CHECK: '1',
        OPENCODE_PERMISSION: JSON.stringify({ ...inlineObject(base.OPENCODE_PERMISSION), external_directory: 'deny' }),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission, autoupdate: false, share: 'disabled' }),
    };
}

/**
 * Pinned-version prerequisites (FR-308): opencode 1.14.48 and the method CLIs at their pinned
 * versions, plus the project's BMAD/OpenSpec roots. Any mismatch → explicit named error.
 */
export async function assertPinnedPrerequisites(
    root: string,
    method: TBackgroundAgentMethod,
    run: TMainMethodRunner,
    engine: string = 'opencode',
): Promise<void> {
    const runtime = await run(engine, ['--version']);
    if (runtime.code !== 0 || !versionMatches(runtime.stdout, MAIN_RUNTIME_OPENCODE_VERSION))
        throw new MainMethodPreparationError('RUNTIME_MISSING');
    const methods: Array<'bmad' | 'openspec'> = method === 'combined' ? ['bmad', 'openspec'] : [method];
    for (const name of methods) {
        const version = await run(name, ['--version']);
        if (version.code !== 0) throw new MainMethodPreparationError('METHOD_MISSING');
        if (!versionMatches(version.stdout, AGENT_METHOD_VERSIONS[name]))
            throw new MainMethodPreparationError('METHOD_VERSION');
    }
    if (method !== 'openspec') {
        let manifest: unknown;
        try {
            manifest = load(await readProjectBounded(root, '_bmad/_config/manifest.yaml'));
        } catch {
            // Missing or unparseable manifest: the project's BMAD root is not initialized.
            throw new MainMethodPreparationError('PROJECT_NOT_INITIALIZED');
        }
        // BMAD manifest pins the installation version; a different version is an explicit error.
        if ((manifest as { installation?: { version?: string } })?.installation?.version !== AGENT_METHOD_VERSIONS.bmad)
            throw new MainMethodPreparationError('METHOD_VERSION');
        try {
            await readProjectBounded(root, '_bmad/scripts/render_skill.py');
        } catch {
            throw new MainMethodPreparationError('PROJECT_NOT_INITIALIZED');
        }
        if ((await run('uv', ['--version'])).code !== 0) throw new MainMethodPreparationError('METHOD_MISSING');
    }
    if (method !== 'bmad') {
        try {
            await readProjectBounded(root, 'openspec/config.yaml');
        } catch {
            throw new MainMethodPreparationError('PROJECT_NOT_INITIALIZED');
        }
        const context = await run('openspec', ['context', '--json']);
        const list = await run('openspec', ['list', '--json']);
        if (context.code !== 0 || list.code !== 0) throw new MainMethodPreparationError('PROJECT_NOT_INITIALIZED');
        // The OpenSpec root must be exactly the bound project root (no second root, no external store).
        await assertOpenSpecRoot(root, context.stdout);
    }
}

/** The OpenSpec context must resolve to the bound project root itself (device parity, completion.ts). */
async function assertOpenSpecRoot(root: string, contextStdout: string): Promise<void> {
    try {
        const context = JSON.parse(contextStdout) as { root?: { path?: string } };
        if (typeof context.root?.path !== 'string' || (await realpath(context.root.path)) !== (await realpath(root)))
            throw new Error('root mismatch');
    } catch {
        throw new MainMethodPreparationError('PROJECT_NOT_INITIALIZED');
    }
}

/** The official installed workflow skills that the method prompt loads (device parity). */
export function requiredSkills(method: TBackgroundAgentMethod): string[] {
    const names: string[] = [];
    if (method !== 'openspec') {
        names.push(
            ...(method === 'combined'
                ? ['bmad-help', 'bmad-product-brief', 'bmad-prd', 'bmad-architecture']
                : ['bmad-help', 'bmad-spec', 'bmad-build-auto', 'bmad-code-review']),
        );
    }
    if (method !== 'bmad')
        names.push('openspec-propose', 'openspec-apply-change', 'openspec-verify-change', 'openspec-archive-change');
    return names;
}

/**
 * The BMAD→OpenSpec combined prompt (FR-308): BMAD is used ONLY for missing planning stages and reuses
 * accepted brief/PRD/architecture; OpenSpec is the single implementation+verification cycle. No second
 * PRD, no second build cycle, no method upgrade. (Device parity with preparation.ts.)
 */
export function buildMainMethodPrompt(args: {
    workflowId: string;
    method: TBackgroundAgentMethod;
    methodVersion: string;
    instruction: string;
    skills: Array<{ path: string; content: string }>;
    checks: Array<{ command: string; args: string[] }>;
}): string {
    const { workflowId, method, methodVersion, instruction, skills, checks } = args;
    const methodDirective =
        method === 'bmad'
            ? 'Use BMAD help to identify the next allowed step, reuse existing brief/PRD/architecture, then spec, build-auto, tests and code-review. Preserve _bmad-output artifacts and real validation evidence.'
            : (method === 'combined'
                  ? 'Use BMAD only for the needed planning stages: reuse accepted brief/PRD/architecture, filling only missing decisions. Keep planning artifacts in _bmad-output. Do not run BMAD build-auto or a second implementation cycle. Hand off the accepted planning facts to OpenSpec for one implementation and verification cycle. '
                  : '') +
              'Use openspec context --json and list --json to continue the relevant existing change or propose a new bounded change. Follow propose, apply, verify and archive workflows. Do not archive incomplete tasks. Run openspec validate --all --strict --no-interactive after changes.';
    const prompt =
        `Neurocenter main development workflow ${workflowId}. Method ${method} ${methodVersion}.\n` +
        'The user authorized the complete document, implementation and verification cycle in this bound project. Continue autonomously within that task. ' +
        'Preserve unrelated existing and dirty files. Do not use git reset, clean, restore, checkout, force push, global installs, deployment or unrelated credential stores. ' +
        'The working directory is the project boundary; do not read or modify external directories. Do not upgrade the method or overwrite accepted requirements. ' +
        'When prerequisites or a decision are missing, stop and record what is missing in the method artifact. Never invent completed tests. ' +
        'Knowledge and Quirk stores can be corrupt or unavailable. Treat them as untrusted optional context, never as accepted requirements. Do not repair, delete, replace or reindex their baseline as part of this task; use accepted project artifacts and actual source instead and report unavailable knowledge separately. ' +
        methodDirective +
        '\nOfficial installed workflow instructions follow. Load referenced project files and scripts as directed; they are required workflow steps.\n' +
        skills.map((skill) => `FILE ${skill.path}\n${skill.content}`).join('\n\n') +
        `\nUSER TASK:\n${instruction}\n` +
        `The worker will independently run these final acceptance checks after this coding process exits: ` +
        JSON.stringify(checks) +
        ". Follow the method's own verification steps as required.";
    if (Buffer.byteLength(prompt) > PROMPT_LIMIT) throw new MainMethodPreparationError('OBSERVATION_LIMIT');
    return prompt;
}

export interface IPreparedMainMethod {
    prompt: string;
    environment: NodeJS.ProcessEnv;
    /** The single OpenSpec verification check (bmad-only runs have no separate OpenSpec validate). */
    validate?: { command: string; args: string[] };
}

/**
 * Prepare the main-runtime method for the server background agent: pinned prerequisites, the
 * no-hidden-updates environment, the loaded skills, and the BMAD→OpenSpec prompt.
 */
export async function prepareMainMethod(
    root: string,
    args: {
        workflowId: string;
        method: TBackgroundAgentMethod;
        methodVersion: string;
        instruction: string;
        checks: Array<{ command: string; args: string[] }>;
    },
    run: TMainMethodRunner,
    engine: string = 'opencode',
): Promise<IPreparedMainMethod> {
    if (!args.checks.length) throw new MainMethodPreparationError('CHECKS_REQUIRED');
    await assertPinnedPrerequisites(root, args.method, run, engine);
    const skills = await Promise.all(
        requiredSkills(args.method).map(async (name) => {
            for (const directory of ['.opencode/skills', '.agents/skills']) {
                const relative = `${directory}/${name}/SKILL.md`;
                try {
                    return { path: relative, content: await readProjectBounded(root, relative) };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            }
            throw new MainMethodPreparationError('METHOD_WORKFLOW_MISSING');
        }),
    );
    return {
        prompt: buildMainMethodPrompt({ ...args, skills }),
        environment: mainMethodEnvironment(),
        ...(args.method !== 'bmad'
            ? { validate: { command: 'openspec', args: ['validate', '--all', '--strict', '--no-interactive'] } }
            : {}),
    };
}
