import {Children, createElement, isValidElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Checkbox} from 'antd';
import {describe, expect, it, vi} from 'vitest';
import AppCard from '../src/modules/Store/AppCard';
import {CatalogUpdateSummary} from '../src/modules/Store/CatalogUpdateSummary';
import type {IProjectCatalogUpdate} from '../src/modules/Store/projectCatalogUpdates';
import type {IStoreApp} from '../src/features/Catalog/types';

const app: IStoreApp = {id: 'rag', name: 'OpenCodeRAG', kind: 'plugin', version: 1, revision: '2.11.0', description: '', origin: '', tags: []};
const update: IProjectCatalogUpdate = {head: {...app, version: 2, revision: '2.12.2'}, project: {assetId: app.id, assetKind: app.kind, version: 1, manifest: 'a'.repeat(64), addedBy: '', addedAt: ''},
    computer: {deviceId: 'computer', projectId: 'project', bindingId: 'folder', assetId: app.id, assetKind: app.kind, version: 1, name: app.name, manifest: 'a'.repeat(64), updatedAt: ''},
    receiptsReady: true, catalogNewer: true, computerDiffers: false, attention: false};
const card = (state: IProjectCatalogUpdate) => renderToStaticMarkup(createElement(AppCard, {app, update: state, installed: true, action: createElement('button', null, 'Закрепить новую версию')}));

describe('Версии и сводка обновлений видны до действия пользователя', () => {
    it('Показывает поставку каталога, точный pin и квитанцию независимо', () => {
        const html = card(update);
        expect(html).toContain('Каталог: 2.12.2 · редакция 2'); expect(html).toContain('Проект: 2.11.0 · редакция 1');
        expect(html).toContain('Компьютер: квитанция редакции 1'); expect(html).toContain('Закрепить новую версию'); expect(html).not.toContain('Установлено');
    });
    it('Отличает другую квитанцию и неизвестную версию компьютера', () => {
        expect(card({...update, computerDiffers: true})).toContain('отличается от проекта');
        const unknown = card({...update, computer: undefined, receiptsReady: false});
        expect(unknown).toContain('Компьютер: версия не подтверждена'); expect(unknown).not.toContain('квитанция редакции');
        expect(card({...update, computer: undefined})).toContain('нет квитанции выбранной папки');
    });
    it('Неполная загрузка не сообщает об отсутствии обновлений', () => {
        const html = renderToStaticMarkup(createElement(CatalogUpdateSummary, {catalogCount: 0, computerCount: 0, incomplete: true, onlyUpdates: false, onChange: vi.fn()}));
        expect(html).toContain('Не все версии подтверждены'); expect(html).not.toContain('Новых редакций в доступном каталоге нет');
    });
    it('Фильтр меняет только показ, без подтверждения или установки версий', () => {
        const onChange = vi.fn(), tree = CatalogUpdateSummary({catalogCount: 1, computerCount: 1, incomplete: false, onlyUpdates: false, onChange});
        const find = (node: ReactNode): ((event: {target: {checked: boolean}}) => void) | undefined => {
            if (!isValidElement<{children?: ReactNode; onChange?: (event: {target: {checked: boolean}}) => void; description?: ReactNode}>(node)) return;
            if (node.type === Checkbox) return node.props.onChange;
            for (const child of Children.toArray(node.props.children ?? node.props.description)) {const found = find(child); if (found) return found;}
        };
        expect(onChange).not.toHaveBeenCalled(); find(tree)!({target: {checked: true}}); expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    });
});
