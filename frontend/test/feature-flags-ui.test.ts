import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagsPanel } from '../src/features/FeatureFlags/FeatureFlagsPanel';
import { FeatureFlagRow } from '../src/features/FeatureFlags/FeatureFlagRow';
import { initialFeatureFlagsState } from '../src/features/FeatureFlags/featureFlagsController';
import { featureDefinition } from '../src/features/FeatureFlags/types';
import type { IFeatureFlag } from '../src/features/FeatureFlags/types';

const ui = vi.hoisted(() => ({ role: 'Главный админ', assigned: ['Главный админ'], hook: vi.fn() }));
vi.mock('react-redux', () => ({ useSelector: (select: (state: unknown) => unknown) => select({ userBlock: { user: {
    id: 'user-one', email: 'admin@example.test', activeRole: ui.role, userRoles: ui.assigned, projectRoles: [], routePermissions: [],
}, policies: {} } }) }));
vi.mock('../src/features/FeatureFlags/useFeatureFlags', () => ({ useFeatureFlags: () => ui.hook() }));
const flag: IFeatureFlag = { ...featureDefinition('model_hosting'), key: 'model_hosting', name: 'Хостинг моделей', description: 'Запуск и содержательная проверка моделей.', enabled: true, revision: 1, updatedAt: '2026-10-19T12:00:00Z', updatedBy: 'system:defaults' };
beforeEach(() => {
    vi.clearAllMocks(); ui.role = 'Главный админ'; ui.assigned = ['Главный админ'];
    ui.hook.mockReturnValue({ ...initialFeatureFlagsState(), items: [flag], refresh: vi.fn(), save: vi.fn(), useCurrent: vi.fn() });
});

describe('Управление функциями в Обслуживании', () => {
    it('Главный администратор видит подтверждённое значение, пояснение и обновление', () => {
        const html = renderToStaticMarkup(createElement(FeatureFlagsPanel));
        expect(html).toContain('Функции платформы'); expect(html).toContain('Хостинг моделей');
        expect(html).toContain('aria-checked="true"'); expect(html).toContain('Начальная настройка');
        expect(html).toContain('Изменения применяются к новым запросам');
        expect(html).toContain('Выполняющиеся запросы не прерываются');
        expect(html).toContain('выгрузка моделей из памяти остаются доступны');
        expect(html).not.toContain('system:defaults');
    });
    it.each(['Админ проекта', 'Разработчик', 'Наблюдатель'])('Роль %s не получает панель и административный запрос', role => {
        ui.role = role; ui.assigned = [role];
        expect(renderToStaticMarkup(createElement(FeatureFlagsPanel))).toBe(''); expect(ui.hook).not.toHaveBeenCalled();
    });
    it('Отозванная активная роль не открывает прежние административные сведения', () => {
        ui.assigned = [];
        expect(renderToStaticMarkup(createElement(FeatureFlagsPanel))).toBe(''); expect(ui.hook).not.toHaveBeenCalled();
    });
    it('Неизвестное состояние показывает ошибку и повтор, без выключенных по умолчанию переключателей', () => {
        ui.hook.mockReturnValue({ ...initialFeatureFlagsState(), readError: 'Нет связи', refresh: vi.fn() });
        const html = renderToStaticMarkup(createElement(FeatureFlagsPanel));
        expect(html).toContain('Состояние функций недоступно'); expect(html).toContain('Повторить загрузку');
        expect(html).not.toContain('role="switch"'); expect(html).not.toContain('Включена'); expect(html).not.toContain('Выключена');
    });
    it('Сохранение и конфликт блокируют переключатель без оптимистичной смены', () => {
        const props = { flag, disabled: false, onChange: vi.fn(), onRefresh: vi.fn(), onUseCurrent: vi.fn() };
        const saving = renderToStaticMarkup(createElement(FeatureFlagRow, { ...props, state: { saving: true, error: null, needsReview: false, saved: false } }));
        expect(saving).toContain('aria-checked="true"'); expect(saving).toContain('disabled'); expect(saving).toContain('Сохраняем настройку');
        const conflict = renderToStaticMarkup(createElement(FeatureFlagRow, { ...props, state: { saving: false, error: 'Другой администратор изменил настройку', needsReview: true, saved: false } }));
        expect(conflict).toContain('Настройку уже изменили'); expect(conflict).toContain('Использовать актуальное значение');
        expect(conflict).toContain('Изменение не повторяется автоматически'); expect(conflict).not.toContain('Изменение подтверждено сервером');
    });
});
