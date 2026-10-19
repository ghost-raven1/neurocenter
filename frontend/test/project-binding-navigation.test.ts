import { configureStore } from '@reduxjs/toolkit';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { IProjectDetail, IProjectSummary } from '../src/core/api/interfaces';
import Projects from '../src/modules/Projects/Projects';
import projectsReducer, { clearSelected, setQuery } from '../src/modules/Projects/redux/reducers';
import { fetchProject, fetchProjects } from '../src/modules/Projects/redux/actions';

vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => true }) }));
vi.mock('../src/core/socket/useSectionUpdates', () => ({ useSectionUpdates: () => {} }));
vi.mock('../src/common/components/Permission', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/components/CreateProjectModal', () => ({ default: () => null }));
vi.mock('../src/modules/Projects/local/LocalProjectsFolder', () => ({ LocalProjectsFolder: ({ project }: { project: IProjectSummary | null }) =>
    createElement('output', { 'data-binding-project': project?.id ?? '' }) }));

const example = { id: 'prj-example-project', name: 'example-project', state: 'ACTIVE' } as IProjectSummary;
const dossier = { id: 'prj-dossier-ko', name: 'dossier-ko', state: 'ACTIVE' } as IProjectDetail;
const user = { activeRole: 'Главный админ', userRoles: ['Главный админ'], projectRoles: [] };

function filteredState() {
    let state = { ...projectsReducer(undefined, { type: 'init' }), authScope: 'fixture' };
    state = projectsReducer(state, setQuery('example'));
    state = projectsReducer(state, fetchProjects.pending('list', { page: 1, size: 10, query: 'example' }));
    return projectsReducer(state, fetchProjects.fulfilled({ items: [example], page: 1, size: 10, total: 1 }, 'list', { page: 1, size: 10, query: 'example' }));
}

function render(state: ReturnType<typeof filteredState>, url: string) {
    const store = configureStore({ reducer: { projects: projectsReducer, userBlock: () => ({ user }) }, preloadedState: { projects: state } });
    return renderToStaticMarkup(createElement(Provider, { store, children:
        createElement(MemoryRouter, { initialEntries: [url], children: createElement(Projects) }) }));
}

describe('Привязка из базы знаний сохраняет целевой проект вне текущего фильтра списка', () => {
    it('Открывает существующий мастер для точного ID, сохраняя поиск и строки списка', () => {
        let state = filteredState();
        state = projectsReducer(state, fetchProject.pending('target', dossier.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'target', dossier.id));
        expect(state.query).toBe('example'); expect(state.list).toEqual([example]);
        expect(render(state, '/projects?bind=prj-dossier-ko')).toContain('data-binding-project="prj-dossier-ko"');
    });

    it('Прежняя выбранная карточка не открывает мастер другого проекта или закрытой ссылки', () => {
        let state = filteredState();
        state = projectsReducer(state, fetchProject.pending('target', dossier.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'target', dossier.id));
        expect(render(state, '/projects?bind=prj-example-project')).toContain('data-binding-project=""');
        expect(render(state, '/projects')).toContain('data-binding-project=""');
    });

    it('Закрытие ссылки отзывает поздний GET и не меняет фильтр', () => {
        let state = projectsReducer(filteredState(), fetchProject.pending('late', dossier.id));
        state = projectsReducer(state, clearSelected());
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'late', dossier.id));
        expect(state.selected).toBeNull(); expect(state.query).toBe('example');
        expect(render(state, '/projects')).toContain('data-binding-project=""');
    });

    it('Смена A на B не принимает прежний GET и открывает только новый проект', () => {
        let state = projectsReducer(filteredState(), fetchProject.pending('first', dossier.id));
        state = projectsReducer(state, fetchProject.pending('second', example.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'first', dossier.id));
        expect(render(state, '/projects?bind=prj-example-project')).toContain('data-binding-project=""');
        state = projectsReducer(state, fetchProject.fulfilled(example as IProjectDetail, 'second', example.id));
        expect(render(state, '/projects?bind=prj-example-project')).toContain('data-binding-project="prj-example-project"');
        expect(state.query).toBe('example'); expect(state.page).toBe(1);
    });

    it.each([403,404])('Отказ %s убирает прежний проект и даёт видимый выход без мастера',status=>{
        let state = projectsReducer(filteredState(), fetchProject.pending('target', dossier.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'target', dossier.id));
        state = projectsReducer(state, fetchProject.pending('refresh', dossier.id));
        state = projectsReducer(state, fetchProject.rejected(null, 'refresh', dossier.id, {status,message:'Проект недоступен'}));
        const html=render(state,'/projects?bind=prj-dossier-ko');
        expect(html).toContain('data-binding-project=""');expect(html).toContain('Проект недоступен');
        expect(html).toContain('Закрыть');expect(state.query).toBe('example');
    });

    it('Некорректная ссылка не открывает мастер уже выбранного проекта',()=>{
        let state = projectsReducer(filteredState(), fetchProject.pending('target', dossier.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'target', dossier.id));
        const html=render(state,'/projects?bind=prj-a%2Fwrong');
        expect(html).toContain('data-binding-project=""');expect(html).toContain('некорректный идентификатор');
    });
    it('Повторная проверка того же ID и временный отказ не открывают мастер по прежней карточке',()=>{
        let state = projectsReducer(filteredState(), fetchProject.pending('target', dossier.id));
        state = projectsReducer(state, fetchProject.fulfilled(dossier, 'target', dossier.id));
        state = projectsReducer(state, fetchProject.pending('refresh', dossier.id));
        expect(render(state,'/projects?bind=prj-dossier-ko')).toContain('data-binding-project=""');
        state = projectsReducer(state, fetchProject.rejected(null,'refresh',dossier.id,{status:503,message:'Сервер временно недоступен'}));
        const html=render(state,'/projects?bind=prj-dossier-ko');
        expect(html).toContain('data-binding-project=""');expect(html).toContain('Сервер временно недоступен');
    });
});
