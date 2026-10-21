import {afterEach, describe, expect, it, vi} from 'vitest';
import type {AxiosAdapter} from 'axios';
import base from '../src/core/api/base';
import {projectLearningApi} from '../src/features/ProjectLearning/api';
import type {LearningCommand, LearningIntent} from '../src/features/ProjectLearning/types';
import {experienceId, hypothesisId, candidateId, requestKey} from './project-learning-fixtures';
const original = base.defaults.adapter;
afterEach(() => {base.defaults.adapter = original;});
function adapter() {const mock = vi.fn<AxiosAdapter>(async config => ({data: {}, status: 200, statusText: 'OK', headers: {}, config})); base.defaults.adapter = mock; return mock;}
const makeIntent = (command: LearningCommand): LearningIntent => ({projectId: 'project/a b', expectedRevision: 7, requestKey, command});

describe('Project learning HTTP boundaries', () => {
    it.each([
        [{kind: 'experience', value: {title: 'T', summary: 'S', outcome: 'unknown', evidence: []}}, '/experiences'],
        [{kind: 'hypothesis', value: {title: 'T', subject: 'agent', statement: 'S', rationale: 'R', verificationPlan: 'P', experienceIds: [experienceId]}}, '/hypotheses'],
        [{kind: 'check', hypothesisId, value: {method: 'human_review', result: 'passed', summary: 'S', experienceIds: [experienceId]}}, `/hypotheses/${hypothesisId}/checks`],
        [{kind: 'candidate', value: {hypothesisId, checkId: experienceId, key: 'lesson', kind: 'lesson', title: 'T', content: 'C'}}, '/candidates'],
        ...(['approve', 'reject', 'revoke', 'activate'] as const).map(kind => [{kind, candidateId, value: {reason: 'reviewed'}}, `/candidates/${candidateId}/${kind}`]),
    ] as Array<[LearningCommand, string]>)('Encodes the project and preserves original %s CAS body', async (command, suffix) => {
        const capture = adapter(), intent = makeIntent(command); await projectLearningApi.mutate(intent); const config = capture.mock.calls[0][0];
        expect(config.url).toBe('/api/projects/project%2Fa%20b/learning' + suffix); expect(config.method).toBe('post'); expect(config.timeout).toBe(30000);
        expect(JSON.parse(config.data)).toEqual({...command.value, requestKey, expectedRevision: 7}); expect(config.withCredentials).toBe(true); expect(config.headers.get('X-Neurocenter-Request')).toBe('1');
    });
    it('AI submission carries only assigned model ID and selected evidence, with no credentials or project body', async () => {
        const capture = adapter(), body = {requestKey, expectedRevision: 8, modelId: 'model-chat', experienceIds: [experienceId]}; await projectLearningApi.analyze('prj-one', body);
        expect(JSON.parse(capture.mock.calls[0][0].data)).toEqual(body); expect(capture.mock.calls[0][0].url).toBe('/api/projects/prj-one/learning/analyses');
    });
    it('Recovery only reads a receipt, and paging uses explicit before cursors', async () => {
        const capture = adapter(); await projectLearningApi.receipt('project/a', requestKey); await projectLearningApi.analysisReceipt('project/a', requestKey); await projectLearningApi.page('project/a', 'experiences', experienceId); await projectLearningApi.history('project/a', 101);
        expect(capture.mock.calls.every(([config]) => config.method === 'get')).toBe(true); expect(capture.mock.calls[1][0].url).toContain('/analyses/requests/'); expect(capture.mock.calls[2][0].params).toEqual({before: experienceId}); expect(capture.mock.calls[3][0].params).toEqual({beforeRevision: 101});
    });
});
