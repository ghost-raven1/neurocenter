import {describe, expect, it} from 'vitest';
import {normalizeProviderReport} from '../../services/shared/opencode-providers.cjs';
import {latestProviderStatus, matchingProviderJobs, providerJob, providerModelEligible, providerReport, providerSetupTarget} from '../src/features/OpenCodeProviders/model';
import type {IProviderSetupRequest} from '../src/features/OpenCodeProviders/types';
import {ack, bridgeFixture, configured, descriptor, identity, model, preparation, preparationId, selection} from './opencode-provider.fixture';

const request: IProviderSetupRequest = {...selection, kind: 'prepare-opencode-provider', requestKey: preparationId};
describe('Public provider contract', () => {
    it.each(['prepare-opencode-provider', 'open-opencode-provider', 'get-opencode-provider-status'] as const)('Matches shared exact report normalizer: %s', kind => {
        const input = {...request, kind}, result = kind === 'get-opencode-provider-status' ? configured() : {...preparation(), ...(kind === 'open-opencode-provider' ? {opened: true} : {})};
        const job = ack(input, {state: 'succeeded', result});
        expect(providerReport(job, input, preparationId)).toEqual(normalizeProviderReport(kind, result, descriptor, false, preparationId));
    });
    it.each(['expectations', 'baseUrl', 'credential', 'token'])('Never accepts private field %s', field => {
        const result = {...preparation(), [field]: 'private-value'}; expect(providerReport(ack(request, {result}), request)).toBeUndefined();
        expect(() => normalizeProviderReport(request.kind, result, descriptor)).toThrow();
    });
    it.each(['deviceId', 'projectId', 'bindingId', 'instanceId', 'modelPin', 'schemaDigest', 'catalogModelId', 'providerId'])('Rejects mismatched report %s', field => {
        expect(providerReport(ack(request, {result: {...preparation(), [field]: 'foreign'}}), request)).toBeUndefined();
    });
    it.each([{state: ['configured']}, {missingFields: [['credential']]}, {ready: true, missingFields: ['credential']}, {revision: 'invalid'},
        {checkedAt: new Date(Date.now() + 120000).toISOString()}, {missingFields: ['login', 'login']}])('Rejects malformed status %j', patch => {
        const input = {...request, kind: 'get-opencode-provider-status' as const}; expect(providerReport(ack(input, {result: {...configured(), ...patch}}), input)).toBeUndefined();
    });
    it.each(['deviceId', 'projectId', 'bindingId', 'expectedInstanceId', 'catalogModelId', 'expectedModelPin', 'providerKind', 'providerSchemaDigest', 'providerId'])('Does not accept wrong ACK %s', key => {
        expect(providerJob({...ack(request), [key]: 'foreign'}, {...request, expectedProviderSchemaDigest: descriptor.schemaDigest})).toBeUndefined();
    });
    it('Rejects malformed ACK state and timestamps', () => {
        expect(providerJob({...ack(request), state: ['queued']}, request)).toBeUndefined();
        expect(providerJob({...ack(request), updatedAt: 'yesterday'}, request)).toBeUndefined();
    });
    it('Requires exact preparation ID for open', () => {
        const input = {...request, kind: 'open-opencode-provider' as const}; expect(providerReport(ack(input, {result: {...preparation(), opened: true}}), input, 'other')).toBeUndefined();
    });
    it('Restores latest status on remount but invalidates it after new open or failed check', () => {
        const input = {...request, kind: 'get-opencode-provider-status' as const};
        const status = ack(input, {state: 'succeeded', result: configured()});
        expect(latestProviderStatus([status], selection)).toEqual(status.result);
        expect(latestProviderStatus([{...status, state: 'failed'}, status], selection)).toBeUndefined();
        expect(latestProviderStatus([{...status, kind: 'open-opencode-provider'}, status], selection)).toBeUndefined();
        expect(matchingProviderJobs([{...status, deviceId: 'foreign'}, status], selection)).toEqual([status]);
    });
    it('Requires current role2, named device, fresh queue and physical instance', () => {
        expect(providerSetupTarget(bridgeFixture(), selection.projectId).target).toEqual({...selection, providerKind: undefined, catalogModelId: undefined, expectedModelPin: undefined});
        for (const patch of [{jobsReady: false}, {devicesReady: false}, {device: {...bridgeFixture().device!, name: ''}},
            {device: {...bridgeFixture().device!, role: 'Наблюдатель'}}, {device: {...bridgeFixture().device!, report: {}}}]) {
            expect(providerSetupTarget({...bridgeFixture(), ...patch}, selection.projectId).target).toBeUndefined();
        }
    });
    it('Only assigned verified API chat/vision cards can be offered by caller', () => {
        expect(providerModelEligible(model)).toBe(true);
        for (const patch of [{capability: 'embedding' as const}, {runtime: 'remote-ollama' as const}, {modelPin: ''}, {verificationSha256: null}, {archivedAt: 'today'}]) expect(providerModelEligible({...model, ...patch})).toBe(false);
    });
    it('Catalog API IDs up to200 remain server models but local OpenCode offers only supported128-character selectors', () => {
        expect(providerModelEligible({...model, model: 'a'.repeat(128)})).toBe(true);
        expect(providerModelEligible({...model, model: 'a'.repeat(129)})).toBe(false);
        expect(providerModelEligible({...model, model: 'a'.repeat(200)})).toBe(false);
    });
    it('Codex identity allows only the pinned public connector reference', () => {
        const input = {...request, providerKind: 'codex-bridge' as const, catalogModelId: undefined, expectedModelPin: undefined};
        const connector = {assetId: 'ai-plug-codex', version: 1, manifest: 'e'.repeat(64), sourceCommit: 'f'.repeat(40)};
        const result = {...preparation(), providerKind: input.providerKind, providerId: 'neurocenter-codex-0123456789abcdef', connector, catalogModelId: null, modelPin: null};
        const job = ack(input, {...result, providerSchemaDigest: identity.schemaDigest, result, expectedModelPin: null});
        expect(providerReport(job, input)).toEqual(result);
        expect(providerReport({...job, result: {...result, connector: {...connector, key: 'private'}}}, input)).toBeUndefined();
    });
});
