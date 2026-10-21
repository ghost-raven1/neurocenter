import {describe, expect, it} from 'vitest';
import {activeLearning, learningCandidates, requireLearningAnalysis, requireLearningOverview, requireLearningReceipt} from '../src/features/ProjectLearning/model';
import {learningTextRule} from '../src/features/ProjectLearning/validation';
import {learningCountLabel} from '../src/features/ProjectLearning/countLabels';
import {candidate, check, hypothesis, learningAnalysis, learningOverview, learningProject, learningReceipt, requestKey} from './project-learning-fixtures';

it.each([[0, 'гипотез', 'действующих знаний'], [1, 'гипотеза', 'действующее знание'], [2, 'гипотезы', 'действующих знания'], [5, 'гипотез', 'действующих знаний'], [11, 'гипотез', 'действующих знаний'], [21, 'гипотеза', 'действующее знание']] as const)('Declines learning counts at %s', (count, hypotheses, knowledge) => {
    expect(learningCountLabel(count, 'hypotheses')).toBe(hypotheses); expect(learningCountLabel(count, 'knowledge')).toBe(knowledge);
});

describe('Learning read boundary and approval semantics', () => {
    it('Accepts a complete bounded project overview', () => {const value = learningOverview(); expect(requireLearningOverview(value, learningProject)).toBe(value);});
    it.each(['experiences', 'hypotheses', 'candidates', 'history'] as const)('Rejects another project in %s', key => {
        const value = learningOverview(); value[key] = [{...value[key][0], projectId: 'other'}] as never;
        expect(() => requireLearningOverview(value, learningProject)).toThrow();
    });
    it('Rejects mixed-project checks and missing capability declarations', () => {
        expect(() => requireLearningOverview(learningOverview({hypotheses: [hypothesis({checks: [check({projectId: 'other'})]})]}), learningProject)).toThrow();
        expect(() => requireLearningOverview({...learningOverview(), capabilities: {read: true}}, learningProject)).toThrow();
    });
    it('Rejects damaged pagination or a nonapproved active entry', () => {
        expect(() => requireLearningOverview({...learningOverview(), pages: {}}, learningProject)).toThrow();
        expect(() => requireLearningOverview(learningOverview({activeCandidates: [candidate({active: true})]}), learningProject)).toThrow();
    });
    it('An old approved active version remains visible outside latest100 and overrides stale list flags', () => {
        const active = candidate({status: 'approved', active: true});
        const result = learningCandidates(learningOverview({candidates: [candidate()], activeCandidates: [active]}));
        expect(result).toEqual([active]); expect(activeLearning(result[0])).toBe(true);
        expect(activeLearning(candidate())).toBe(false); expect(activeLearning(candidate({status: 'approved'}))).toBe(false);
    });
    it('Requires the exact project, request and schema before claiming a mutation saved', () => {
        const receipt = learningReceipt(); expect(requireLearningReceipt(receipt, learningProject, requestKey)).toBe(receipt);
        for (const patch of [{projectId: 'other'}, {requestKey: 'other'}, {revision: -1}, {schemaVersion: 2}, {result: null}]) expect(() => requireLearningReceipt({...receipt, ...patch}, learningProject, requestKey)).toThrow();
    });
    it('An AI receipt never substitutes another project or request', () => {
        expect(requireLearningAnalysis(learningAnalysis(), learningProject, requestKey).state).toBe('queued');
        for (const patch of [{projectId: 'other'}, {requestKey: 'other'}, {state: 'succeeded'}, {hypothesisIds: null}]) expect(() => requireLearningAnalysis({...learningAnalysis(), ...patch}, learningProject, requestKey)).toThrow();
    });
});

describe('UTF8 validation matches persisted byte limits', () => {
    const rule = learningTextRule(8);
    it('Counts Cyrillic and emoji in bytes rather than characters', async () => {
        await expect(rule.validator(null, 'АБВГ')).resolves.toBeUndefined(); await expect(rule.validator(null, '😀😀')).resolves.toBeUndefined();
        await expect(rule.validator(null, 'АБВГД')).rejects.toThrow('10'); await expect(rule.validator(null, '😀😀😀')).rejects.toThrow('12');
    });
    it('Rejects controls and broken UTF16 while allowing multiline prose', async () => {
        await expect(rule.validator(null, 'a\nb')).resolves.toBeUndefined(); await expect(rule.validator(null, 'a\0b')).rejects.toThrow(); await expect(rule.validator(null, '\ud800')).rejects.toThrow();
    });
});
