import {describe, expect, it} from 'vitest';
import {navigationEntries, selectedNavigationEntry} from '../src/features/AppNavigation/model';

const structure = ['start', 'store', 'assets', 'projects', 'rag', 'maintenance', 'audit', 'model-usage', 'access', 'settings', 'help']
    .map(name => ({name, route: '/' + name, title: name}));

describe('Grouped navigation keeps every authorized route reachable', () => {
    it('Keeps onboarding separate and groups existing sections by user task', () => {
        const entries = navigationEntries(structure, structure.map(item => item.name));
        expect(entries.find(item => item.name === 'start')?.group).toBeNull();
        expect(entries.filter(item => item.group === 'work').map(item => item.name)).toEqual(['projects', 'rag']);
        expect(entries.filter(item => item.group === 'resources').map(item => item.name)).toEqual(['store', 'assets']);
        expect(entries.filter(item => item.group === 'management').map(item => item.name)).toEqual(['maintenance', 'audit', 'model-usage', 'access', 'settings']);
        expect(entries.filter(item => item.group === 'help').map(item => item.name)).toEqual(['help', 'api-docs']);
    });
    it('Filters individual routes before grouping and retains the existing documentation link', () => {
        expect(navigationEntries(structure, ['projects', 'store']).map(item => item.route)).toEqual(['/store', '/projects', '/api/docs']);
        expect(navigationEntries(structure, []).map(item => item.name)).toEqual(['api-docs']);
    });
    it('Does not drop a newly registered authorized module', () => {
        const entry = {name: 'new-module', route: '/future', title: 'Новый раздел'};
        expect(navigationEntries([entry], ['new-module'])[0]).toEqual({...entry, group: 'work'});
    });
    it('Selects a nested route only at the path boundary and uses the most specific parent', () => {
        const entries = navigationEntries([...structure, {name: 'project-settings', route: '/projects/settings', title: 'Настройки проекта'}], ['projects', 'project-settings']);
        expect(selectedNavigationEntry(entries, '/projects/example')?.name).toBe('projects');
        expect(selectedNavigationEntry(entries, '/projects/settings/member')?.name).toBe('project-settings');
        expect(selectedNavigationEntry(entries, '/projects-other')).toBeUndefined();
    });
});
