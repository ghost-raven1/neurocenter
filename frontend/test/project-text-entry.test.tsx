import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import RagTab from '../src/modules/Projects/components/RagTab';

vi.mock('react-redux', () => ({useSelector: () => ({activeRole:'Главный админ', userRoles:['Главный админ'], projectRoles:[]})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope:'owner', captureOwner:() => () => true})}));
vi.mock('../src/core/socket/useSectionUpdates', () => ({useSectionUpdates:vi.fn()}));
vi.mock('../src/features/ProjectTextKnowledge/ProjectTextKnowledge', () => ({ProjectTextKnowledge:({projectId}:{projectId:string}) => createElement('div', {'data-text-knowledge':projectId}, 'Добавить текстовые файлы')}));
vi.mock('../src/features/McpBridge/KnowledgeSync', () => ({KnowledgeSync:() => createElement('div', null, 'EAGER_BRIDGE')}));
vi.mock('../src/features/ProjectEmbedding/ProjectEmbedding', () => ({ProjectEmbedding:() => createElement('div', null, 'EAGER_EMBEDDING')}));

it('knowledge opens in text mode with semantic/bridge components unmounted until explicitly expanded', () => {
    const html = renderToStaticMarkup(createElement(RagTab, {projectKey:'prj-text'}));
    expect(html).toContain('data-text-knowledge="prj-text"');
    expect(html).toContain('Семантический поиск и локальный индекс');
    expect(html).not.toContain('EAGER_BRIDGE');
    expect(html).not.toContain('EAGER_EMBEDDING');
    expect(html).not.toContain('Установить OpenCodeRAG');
});
