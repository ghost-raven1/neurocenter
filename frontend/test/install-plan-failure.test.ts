import { describe, expect, it } from 'vitest';
import type { IStoreApp } from '../src/modules/Store/AppCard';
import { installPlanFailureExplanation, parseInstallPlanFailure } from '../src/modules/Store/installPlans/installPlanFailure';

const app: IStoreApp = { id: 'root', kind: 'plugin', name: 'Помощник', version: 3, description: '', tags: [], origin: 'catalog' };
const root = { id: app.id, kind: app.kind, name: app.name, version: app.version };
const dependency = { id: 'dep', kind: 'mcp', name: 'MCP поиска', version: 1 };
const reason = 'Внешняя команда MCP не входит в закреплённый пакет. Загрузите готовый Node-пакет с точкой входа или используйте удалённый MCP.';
const data = { code: 'PACKAGE_NOT_INSTALLABLE', message: 'Зависимость недоступна', reason, package: dependency,
    root, dependency: true, path: [root, dependency] };
const failure = (value: unknown = data, status = 409) => ({ isAxiosError: true, response: { status, data: value } });

describe('Структурированный отказ закреплённого комплекта', () => {
    it('Сохраняет точную проблемную зависимость и весь путь от запрошенной версии', () => {
        const { code: _code, ...expected } = data;
        expect(parseInstallPlanFailure(failure(), app)).toEqual(expected);
    });
    it('Принимает отказ самого инструмента без пути зависимости', () => {
        expect(parseInstallPlanFailure(failure({ ...data, package: root, dependency: false, path: [root] }), app))
            .toMatchObject({ package: root, dependency: false });
    });
    it.each([{ id: 'other' }, { kind: 'mcp' }, { version: 4 }])('Не привязывает чужой ответ к текущей карточке: %j', change => {
        expect(parseInstallPlanFailure(failure(), { ...app, ...change } as IStoreApp)).toBeNull();
    });
    it.each([
        null, [], { ...data, code: 'OTHER' }, { ...data, message: '' }, { ...data, reason: 12 },
        { ...data, dependency: 'true' }, { ...data, dependency: false }, { ...data, path: [] },
        { ...data, path: [dependency, root] }, { ...data, path: [root, { ...dependency, version: 2 }] },
        { ...data, path: [root, root, dependency] }, { ...data, path: [...Array(21).fill(root), dependency] },
        { ...data, package: { ...dependency, version: -1 } }, { ...data, package: { ...dependency, kind: {} } },
        { ...data, root: { ...root, name: 'Подменённое имя' } },
        { ...data, package: { ...dependency, id: 'dep\nother' } },
    ])('Отклоняет повреждённую структуру без действий по её данным: %j', value => {
        expect(parseInstallPlanFailure(failure(value), app)).toBeNull();
    });
    it.each([400, 401, 403, 500])('Не преобразует другой HTTP-отказ в исправление комплекта: %s', status => {
        expect(parseInstallPlanFailure(failure(data, status), app)).toBeNull();
    });
    it('Не доверяет объекту без признака Axios-ошибки', () => {
        expect(parseInstallPlanFailure({ response: { status: 409, data } }, app)).toBeNull();
    });
    it('Объясняет внешний запуск, сохраняя другие причины сервера дословно', () => {
        const parsed = parseInstallPlanFailure(failure(), app)!;
        expect(installPlanFailureExplanation(parsed)).toContain('В этой версии нет готового комплекта');
        expect(installPlanFailureExplanation({ ...parsed, reason: 'Повреждена схема настройки.' })).toBe('Повреждена схема настройки.');
    });
});
