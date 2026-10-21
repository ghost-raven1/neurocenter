import {describe, expect, it} from 'vitest';
import {clearLearningIntent, learningIntentScope, readLearningIntent, saveLearningIntent, validLearningIntent} from '../src/features/ProjectLearning/intentStore';
import type {LearningIntent} from '../src/features/ProjectLearning/types';
import {learningProject, requestKey} from './project-learning-fixtures';

export function memoryLearningStorage(): Storage {
    const values = new Map<string, string>();
    return {get length() {return values.size;}, clear: () => values.clear(), getItem: key => values.get(key) ?? null, key: index => [...values.keys()][index] ?? null, removeItem: key => {values.delete(key);}, setItem: (key, value) => {values.set(key, value);}};
}
const intent = (): LearningIntent => ({projectId: learningProject, requestKey, expectedRevision: 3, command: {kind: 'experience', value: {title: 'T', summary: 'S', outcome: 'unknown', evidence: []}}});

describe('Durable project learning request identity', () => {
    it('Separates identity/role and project; persists exact input for same-key replay', () => {
        const storage = memoryLearningStorage(), key = learningIntentScope('admin', learningProject), value = intent();
        saveLearningIntent(key, value, storage); expect(readLearningIntent(key, learningProject, storage)).toEqual(value);
        expect(readLearningIntent(learningIntentScope('reader', learningProject), learningProject, storage)).toBeNull(); expect(readLearningIntent(learningIntentScope('admin', 'other'), 'other', storage)).toBeNull();
    });
    it('Cannot replace an unresolved request with a different body or CAS revision', () => {
        const storage = memoryLearningStorage(), value = intent(); saveLearningIntent('key', value, storage); saveLearningIntent('key', value, storage);
        expect(() => saveLearningIntent('key', {...value, expectedRevision: 4}, storage)).toThrow('не подтверждён');
        expect(() => saveLearningIntent('key', {...value, command: {kind: 'experience', value: {...value.command.value as object, title: 'Changed'} as never}}, storage)).toThrow();
    });
    it('An old acknowledgement cannot clear a newer operation', () => {
        const storage = memoryLearningStorage(); saveLearningIntent('key', intent(), storage);
        expect(() => clearLearningIntent('key', crypto.randomUUID(), learningProject, storage)).toThrow(); expect(readLearningIntent('key', learningProject, storage)).not.toBeNull();
        clearLearningIntent('key', requestKey, learningProject, storage); expect(readLearningIntent('key', learningProject, storage)).toBeNull();
    });
    it('Rejects damaged data, a different project and unknown operation routes', () => {
        const storage = memoryLearningStorage(); storage.setItem('bad', '{'); expect(() => readLearningIntent('bad', learningProject, storage)).toThrow();
        for (const patch of [{projectId: 'other'}, {expectedRevision: -1}, {requestKey: '../bad'}, {command: {kind: 'delete-project', value: {}}}]) expect(validLearningIntent({...intent(), ...patch}, learningProject)).toBe(false);
    });
    it('Storage failure is explicit before a mutation can be sent', () => {
        const storage = memoryLearningStorage(); storage.setItem = () => {throw new Error('QuotaExceeded');}; expect(() => saveLearningIntent('key', intent(), storage)).toThrow('Запись не отправлена');
    });
});
