import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { codexFixture } from '../../test/codex-runtime.fixture.mjs';

test('bundled refactored Codex modules compile and share the account-scoped auth session', async () => {
    const fixture = await codexFixture({ bundled: true });
    const originalFetch = globalThis.fetch;
    try {
        assert.equal(fixture.downloads.length, 0);
        assert.ok(
            fixture.result.upstream.compatibilityPatches.some((patch) => patch.id === 'neurocenter-module-layout'),
        );
        const setup = await fixture.setup();
        const models = await setup.readCodexModels({ codexHome: fixture.options.codexHome });
        assert.equal(models.defaultModel, 'gpt-synthetic');
        const plugin = await fixture.plugin();
        assert.deepEqual(await plugin.default(), {});
        fixture.options.codexHome = path.join(fixture.root, 'account-a');
        const managed = await plugin.createManagedCodexPlugin(fixture.options)({ directory: fixture.root });
        const loader = await managed.auth.loader();
        assert.equal(typeof loader.fetch, 'function');
        let observedAccount;
        globalThis.fetch = async (_url, options) => {
            observedAccount = new Headers(options.headers).get('ChatGPT-Account-Id');
            return new Response('data: done\n\n', { headers: { 'content-type': 'text/event-stream' } });
        };
        const response = await loader.fetch('https://api.openai.com/v1/responses', {
            method: 'POST',
            body: JSON.stringify({ stream: true, input: [] }),
        });
        assert.equal(await response.text(), 'data: done\n\n');
        assert.equal(observedAccount, 'account-a');
        await assert.rejects(
            loader.fetch('https://untrusted.example/responses', { method: 'POST', body: '{}' }),
            /official/,
        );
    } finally {
        globalThis.fetch = originalFetch;
        await fixture.close();
    }
});
