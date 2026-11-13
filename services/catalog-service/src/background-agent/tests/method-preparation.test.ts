import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MAIN_RUNTIME_OPENCODE_VERSION,
    MainMethodPreparationError,
    mainMethodEnvironment,
    prepareMainMethod,
    requiredSkills,
    type TMainMethodRunner,
} from '../method-preparation';

const OPENCODE = '1.14.48';
const BMAD = '6.12.4';
const OPENSPEC = '1.15.0';

let workDir: string;
beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'nc-bg-method-'));
});
afterEach(() => {});

/** A realistic project root: pinned BMAD manifest, render script, OpenSpec config, and the required skills. */
function seedProject(root: string, method: 'bmad' | 'openspec' | 'combined'): void {
    if (method !== 'openspec') {
        mkdirSync(path.join(root, '_bmad/_config'), { recursive: true });
        mkdirSync(path.join(root, '_bmad/scripts'), { recursive: true });
        writeFileSync(path.join(root, '_bmad/_config/manifest.yaml'), `installation:\n  version: "${BMAD}"\n`);
        writeFileSync(path.join(root, '_bmad/scripts/render_skill.py'), '# render skill\n');
    }
    if (method !== 'bmad')
        (mkdirSync(path.join(root, 'openspec'), { recursive: true }),
            writeFileSync(path.join(root, 'openspec/config.yaml'), 'schema: spec-driven\n'));
    for (const name of requiredSkills(method)) {
        const dir = path.join(root, '.opencode/skills', name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            path.join(root, '.opencode/skills', name, 'SKILL.md'),
            `---\nname: ${name}\n---\n${name} instructions.\n`,
        );
    }
}
const makeOkRunner =
    (root: string): TMainMethodRunner =>
    async (command, args) => {
        if (command === 'opencode') return { code: 0, stdout: OPENCODE };
        if (command === 'bmad') return { code: 0, stdout: BMAD };
        if (command === 'openspec') {
            if (args[0] === 'context') return { code: 0, stdout: JSON.stringify({ root: { path: root } }) };
            if (args[0] === 'list') return { code: 0, stdout: '[]' };
            return { code: 0, stdout: OPENSPEC };
        }
        if (command === 'uv') return { code: 0, stdout: 'uv 0.0.0' };
        return { code: 0, stdout: '' };
    };
const base = {
    workflowId: 'workflow-1',
    methodVersion: OPENSPEC,
    instruction: 'Сделай фичу',
    checks: [{ command: 'npm', args: ['test'] }],
};

describe('FR-308 main-runtime BMAD→OpenSpec preparation (server port of prepareMethod)', () => {
    it('prepares a pinned combined method: prompt + no-hidden-updates env + OpenSpec validate', async () => {
        seedProject(workDir, 'combined');
        const prepared = await prepareMainMethod(workDir, { ...base, method: 'combined' }, makeOkRunner(workDir));
        expect(prepared.validate).toEqual({
            command: 'openspec',
            args: ['validate', '--all', '--strict', '--no-interactive'],
        });
        expect(prepared.prompt).toContain(`Method combined ${OPENSPEC}`);
        // BMAD→OpenSpec combined: reuse accepted planning, one implementation cycle, no second build.
        expect(prepared.prompt).toContain('reuse accepted brief/PRD/architecture');
        expect(prepared.prompt).toContain('Do not run BMAD build-auto or a second implementation cycle');
        expect(prepared.prompt).toContain('one implementation and verification cycle');
        expect(prepared.prompt).toContain('Run openspec validate --all --strict --no-interactive after changes');
        // The loaded official skills are inlined.
        expect(prepared.prompt).toContain('FILE .opencode/skills/bmad-prd/SKILL.md');
        expect(prepared.prompt).toContain('FILE .opencode/skills/openspec-apply-change/SKILL.md');
    });

    it('is fail-closed on a wrong opencode version (explicit, no silent substitution)', async () => {
        seedProject(workDir, 'combined');
        const runner: TMainMethodRunner = async (command) =>
            command === 'opencode' ? { code: 0, stdout: '1.99.99' } : makeOkRunner(workDir)(command, []);
        await expect(prepareMainMethod(workDir, { ...base, method: 'combined' }, runner)).rejects.toThrow(
            MainMethodPreparationError,
        );
        await expect(prepareMainMethod(workDir, { ...base, method: 'combined' }, runner)).rejects.toMatchObject({
            code: 'RUNTIME_MISSING',
        });
        expect(MAIN_RUNTIME_OPENCODE_VERSION).toBe(OPENCODE);
    });

    it('is fail-closed on a wrong pinned method version (METHOD_VERSION)', async () => {
        seedProject(workDir, 'combined');
        const runner: TMainMethodRunner = async (command) =>
            command === 'openspec' ? { code: 0, stdout: '1.14.0' } : makeOkRunner(workDir)(command, []);
        await expect(prepareMainMethod(workDir, { ...base, method: 'combined' }, runner)).rejects.toMatchObject({
            code: 'METHOD_VERSION',
        });
    });

    it('is fail-closed when the BMAD manifest pins a different version', async () => {
        seedProject(workDir, 'combined');
        writeFileSync(path.join(workDir, '_bmad/_config/manifest.yaml'), 'installation:\n  version: "5.0.0"\n');
        await expect(
            prepareMainMethod(workDir, { ...base, method: 'combined' }, makeOkRunner(workDir)),
        ).rejects.toMatchObject({
            code: 'METHOD_VERSION',
        });
    });

    it('is fail-closed when the project is not initialized (missing manifest / openspec config)', async () => {
        const emptyBmad = mkdtempSync(path.join(tmpdir(), 'nc-bg-method-empty-'));
        await expect(
            prepareMainMethod(emptyBmad, { ...base, method: 'combined' }, makeOkRunner(emptyBmad)),
        ).rejects.toMatchObject({
            code: 'PROJECT_NOT_INITIALIZED',
        });
        const noOpenspec = mkdtempSync(path.join(tmpdir(), 'nc-bg-method-no-openspec-'));
        seedProject(noOpenspec, 'bmad');
        await expect(
            prepareMainMethod(noOpenspec, { ...base, method: 'combined' }, makeOkRunner(noOpenspec)),
        ).rejects.toMatchObject({
            code: 'PROJECT_NOT_INITIALIZED',
        });
    });

    it('never downloads/installs: the environment disables telemetry, update checks and auto-update', () => {
        const env = mainMethodEnvironment({});
        expect(env.OPENSPEC_TELEMETRY).toBe('0');
        expect(env.OPENSPEC_NO_UPDATE_CHECK).toBe('1');
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
        expect(config.autoupdate).toBe(false);
        expect(config.share).toBe('disabled');
        expect(config.permission.external_directory).toBe('deny');
        const permission = JSON.parse(env.OPENCODE_PERMISSION ?? '{}');
        expect(permission.external_directory).toBe('deny');
    });

    it('preserves a pre-existing valid OpenCode config and layers the constraints on top', () => {
        const existing = JSON.stringify({
            provider: { 'my-provider': { npm: '@x/provider' } },
            model: 'my-provider/my-model',
            share: 'enabled',
            permission: { external_directory: 'allow' },
        });
        const env = mainMethodEnvironment({ OPENCODE_CONFIG_CONTENT: existing });
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
        expect(config.provider).toEqual({ 'my-provider': { npm: '@x/provider' } });
        expect(config.model).toBe('my-provider/my-model');
        expect(config.autoupdate).toBe(false);
        expect(config.share).toBe('disabled');
        expect(config.permission).toEqual({ external_directory: 'deny' });
    });

    it('rejects a corrupt pre-existing OpenCode config (fail-closed, RUNTIME_MISSING)', () => {
        expect(() => mainMethodEnvironment({ OPENCODE_CONFIG_CONTENT: '{not-json' })).toThrow(
            MainMethodPreparationError,
        );
        expect(() => mainMethodEnvironment({ OPENCODE_CONFIG_CONTENT: '{not-json' })).toThrowError(
            expect.objectContaining({ code: 'RUNTIME_MISSING' }),
        );
    });

    it('is fail-closed when the OpenSpec root is not the bound project root (no second root)', async () => {
        seedProject(workDir, 'combined');
        const otherRoot = mkdtempSync(path.join(tmpdir(), 'nc-bg-method-other-'));
        const runner: TMainMethodRunner = async (command, args) =>
            command === 'openspec' && args[0] === 'context'
                ? { code: 0, stdout: JSON.stringify({ root: { path: otherRoot } }) }
                : makeOkRunner(workDir)(command, args);
        await expect(prepareMainMethod(workDir, { ...base, method: 'combined' }, runner)).rejects.toMatchObject({
            code: 'PROJECT_NOT_INITIALIZED',
        });
    });

    it('is fail-closed when the BMAD manifest is corrupt YAML (PROJECT_NOT_INITIALIZED)', async () => {
        seedProject(workDir, 'combined');
        writeFileSync(path.join(workDir, '_bmad/_config/manifest.yaml'), 'installation: [unclosed\n  ::\n');
        await expect(
            prepareMainMethod(workDir, { ...base, method: 'combined' }, makeOkRunner(workDir)),
        ).rejects.toMatchObject({
            code: 'PROJECT_NOT_INITIALIZED',
        });
    });

    it('bmad-only runs have no separate OpenSpec validate and reuse the BMAD directive', async () => {
        seedProject(workDir, 'bmad');
        const prepared = await prepareMainMethod(
            workDir,
            { ...base, method: 'bmad', methodVersion: BMAD },
            makeOkRunner(workDir),
        );
        expect(prepared.validate).toBeUndefined();
        expect(prepared.prompt).toContain('reuse existing brief/PRD/architecture');
    });

    it('requires at least one acceptance check (CHECKS_REQUIRED)', async () => {
        seedProject(workDir, 'combined');
        await expect(
            prepareMainMethod(workDir, { ...base, method: 'combined', checks: [] }, makeOkRunner(workDir)),
        ).rejects.toMatchObject({
            code: 'CHECKS_REQUIRED',
        });
    });

    it('lists the exact required skills per method (device parity)', () => {
        expect(requiredSkills('combined').sort()).toEqual(
            [
                'bmad-architecture',
                'bmad-help',
                'bmad-product-brief',
                'bmad-prd',
                'openspec-apply-change',
                'openspec-archive-change',
                'openspec-propose',
                'openspec-verify-change',
            ].sort(),
        );
        expect(requiredSkills('openspec')).toEqual([
            'openspec-propose',
            'openspec-apply-change',
            'openspec-verify-change',
            'openspec-archive-change',
        ]);
        expect(requiredSkills('bmad')).toEqual(['bmad-help', 'bmad-spec', 'bmad-build-auto', 'bmad-code-review']);
    });
});
