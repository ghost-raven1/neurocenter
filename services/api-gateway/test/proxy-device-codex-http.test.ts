import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {deviceHeaders, jobId, lease, proxyHttpFixture, reply} from './proxy-http.fixture';

describe.sequential('Codex device execution crosses the real HTTP Gateway boundary', () => {
    let fixture: Awaited<ReturnType<typeof proxyHttpFixture>>;
    beforeEach(async () => {
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', 'qa-proxy-internal');
        fixture = await proxyHttpFixture();
    });
    afterEach(async () => {await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs();});

    it.each(['context', 'dispatch'])('forwards only the protected Codex %s with current device identity', async action => {
        const body = {jobId, lease, ...(action === 'dispatch' ? {callId: jobId} : {})};
        const response = await fixture.send('/api/device-channel/codex-inference/' + action, {method: 'POST', headers: deviceHeaders, body});
        expect(response.status).toBe(200);
        const forwarded = fixture.calls.find(call => call.path === '/internal/device-channel/codex-inference/' + action);
        expect(forwarded?.body).toEqual(body);
        expect(forwarded?.headers.authorization).toBe(deviceHeaders.authorization);
    });

    it.each(['context', 'dispatch'])('refuses new Codex %s after device revocation', async action => {
        fixture.state.deviceStatus = 401;
        expect((await fixture.send('/api/device-channel/codex-inference/' + action, {method: 'POST', headers: deviceHeaders, body: {jobId, lease}})).status).toBe(401);
        expect(fixture.calls.some(call => call.path.endsWith('/codex-inference/' + action))).toBe(false);
    });

    it.each(['context/extra', 'dispatch/extra', 'complete', 'status'])('rejects nearby Codex paths: %s', async action => {
        expect((await fixture.send('/api/device-channel/codex-inference/' + action, {method: 'POST', headers: deviceHeaders, body: {}})).status).toBe(404);
        expect(fixture.calls).toEqual([]);
    });

    it('lets Catalog validate a previously dispatched private receipt after revocation and flag OFF', async () => {
        fixture.state.deviceStatus = 401;
        fixture.state.flags.device_codex_inference = false;
        const body = {lease, state: 'failed', result: {protocol: 'device-codex-inference-v1', callId: jobId, error: {code: 'authorization'}}};
        const response = await fixture.send('/api/device-channel/jobs/' + jobId + '/complete', {method: 'POST', headers: deviceHeaders, body});
        expect(response.status).toBe(200);
        const forwarded = fixture.calls.find(call => call.path === '/internal/device-channel/jobs/' + jobId + '/complete');
        expect(forwarded?.body).toEqual(body);
        expect(forwarded?.headers.authorization).toBe(deviceHeaders.authorization);
        expect(fixture.live.bridge).not.toHaveBeenCalled();
    });

    it('preserves the Catalog refusal for a forged or unknown private receipt', async () => {
        fixture.state.deviceStatus = 401;
        fixture.state.handler = (_req, res) => reply(res, 401, {message: 'Unknown retained receipt identity'});
        const result = {protocol: 'device-codex-inference-v1', callId: jobId, error: {code: 'authorization'}};
        expect((await fixture.send('/api/device-channel/jobs/' + jobId + '/complete', {method: 'POST', headers: deviceHeaders, body: {lease, state: 'failed', result}})).status).toBe(401);
        expect(fixture.calls.some(call => call.path.endsWith('/complete'))).toBe(true);
        expect(fixture.live.sections).not.toHaveBeenCalled();
    });

    it('keeps ordinary completion behind current device identity', async () => {
        fixture.state.deviceStatus = 401;
        expect((await fixture.send('/api/device-channel/jobs/' + jobId + '/complete', {method: 'POST', headers: deviceHeaders, body: {lease, state: 'succeeded', result: {}}})).status).toBe(401);
        expect(fixture.calls.some(call => call.path.endsWith('/complete'))).toBe(false);
    });
});
