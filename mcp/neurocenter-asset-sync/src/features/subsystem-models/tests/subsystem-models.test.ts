import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveSubsystemModels, resolveSubsystemModelsFromInputs } from '../index.js';

const roots: string[] = [];
afterEach(async () => {
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** Изолированный home с XDG-слоями, без наследования реального окружения. */
async function makeHome(): Promise<{ home: string; env: NodeJS.ProcessEnv; configPath: string; ragPath: string }> {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'subsystem-models-')));
    roots.push(home);
    const env = { XDG_CONFIG_HOME: path.join(home, '.config') } as NodeJS.ProcessEnv;
    const configDir = path.join(home, '.config', 'opencode');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    return {
        home,
        env,
        configPath: path.join(configDir, 'opencode.json'),
        ragPath: path.join(home, 'opencode-rag.json'),
    };
}

const fullConfig = {
    model: 'openai/gpt-4o',
    provider: {
        openai: {
            options: { apiKey: 'sk-synthetic-test-key' },
            models: {
                'gpt-4o': { name: 'GPT-4o' },
                'gpt-4o-vision': { name: 'GPT-4o Vision', modalities: { input: ['image', 'text'] } },
            },
        },
    },
};

describe('resolveSubsystemModels (device opencode config, no catalog fallback)', () => {
    it('resolves chat/vision/rag-embedding from a complete config with keys', async () => {
        const { home, env, configPath, ragPath } = await makeHome();
        await fs.writeFile(configPath, JSON.stringify(fullConfig), { mode: 0o600 });
        await fs.writeFile(
            ragPath,
            JSON.stringify({ embedding: { provider: 'openai', model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1' } }),
            { mode: 0o600 },
        );
        const result = await resolveSubsystemModels({ root: home, home, environment: env, ragConfigPath: ragPath });
        expect(result.status).toBe('ok');
        expect(result.configPresent).toBe(true);
        const byName = Object.fromEntries(result.subsystems.map((s) => [s.subsystem, s]));
        expect(byName.chat.status).toBe('resolved');
        expect(byName.chat.provider).toBe('openai');
        expect(byName.chat.hasKey).toBe(true);
        expect(byName.vision.status).toBe('resolved');
        expect(byName.vision.hasKey).toBe(true);
        expect(byName['rag-embedding'].status).toBe('resolved');
        expect(byName['rag-embedding'].hasKey).toBe(true);
    });

    it('reports explicit config-missing with guidance when no opencode config exists', async () => {
        const { home, env } = await makeHome();
        const result = await resolveSubsystemModels({ root: home, home, environment: env });
        expect(result.status).toBe('config-missing');
        expect(result.configPresent).toBe(false);
        expect(result.guidance).toMatch(/opencode\.json/);
        for (const subsystem of ['chat', 'vision', 'rag-embedding']) {
            const row = result.subsystems.find((s) => s.subsystem === subsystem);
            expect(row?.status).toBe('config-missing');
            expect(row?.guidance).toBeTruthy();
        }
    });

    it('resolves chat but keeps vision/rag as config-missing when incomplete', async () => {
        const { home, env, configPath } = await makeHome();
        await fs.writeFile(
            configPath,
            JSON.stringify({ model: 'openai/gpt-4o', provider: { openai: { options: { apiKey: 'sk-synthetic' }, models: { 'gpt-4o': {} } } } }),
            { mode: 0o600 },
        );
        const result = await resolveSubsystemModels({ root: home, home, environment: env });
        expect(result.status).toBe('config-missing');
        expect(result.configPresent).toBe(true);
        const byName = Object.fromEntries(result.subsystems.map((s) => [s.subsystem, s]));
        expect(byName.chat.status).toBe('resolved');
        expect(byName.vision.status).toBe('config-missing');
        expect(byName['rag-embedding'].status).toBe('config-missing');
    });

    it('core: vision requires a key and no blocker', () => {
        const candidate = (over: Record<string, unknown>) =>
            ({
                candidateId: 'id',
                provider: 'openai',
                name: 'm',
                model: 'm',
                modelVersion: 'm',
                capability: 'vision',
                runtime: 'remote-openai',
                baseUrl: 'https://api.openai.com/v1',
                hasKey: true,
                credentialSource: 'inline',
                blocker: null,
                ...over,
            }) as any;
        const resolved = resolveSubsystemModelsFromInputs({
            candidates: [candidate({}), { ...candidate({}), capability: 'chat' } as any],
            defaultModel: 'openai/m',
        });
        expect(resolved.subsystems.find((s) => s.subsystem === 'vision')?.status).toBe('resolved');
        const noKey = resolveSubsystemModelsFromInputs({ candidates: [candidate({ hasKey: false, credentialSource: 'none' })] });
        expect(noKey.subsystems.find((s) => s.subsystem === 'vision')?.status).toBe('config-missing');
        const blocked = resolveSubsystemModelsFromInputs({ candidates: [candidate({ blocker: 'disabled-provider' })] });
        expect(blocked.subsystems.find((s) => s.subsystem === 'vision')?.status).toBe('config-missing');
    });
});
