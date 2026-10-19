import { configureStore } from '@reduxjs/toolkit';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { Provider } from 'react-redux';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import ProtectedRoute from '../src/common/components/ProtectedRoute';
import { LazySectionBoundary, lazySection } from '../src/common/components/LazySection/LazySection';
import type { IAuthMe } from '../src/core/interfaces';

const auth: IAuthMe = {
    user: { id: 'one', email: 'one@example.test', principalName: 'one', displayName: 'Первый', activeRole: 'Главный администратор', userRoles: ['Главный администратор'], routePermissions: ['section'], projectRoles: [] },
    policies: { section: ['read'] },
};

function renderSection(Section: ReturnType<typeof lazySection>, currentAuth: IAuthMe | null = auth, isAuth = currentAuth !== null) {
    const context: { url?: string } = {};
    const store = configureStore({ reducer: { userBlock: () => ({ isAuth, user: currentAuth?.user ?? null, policies: currentAuth?.policies ?? {} }) } });
    const html = renderToString(createElement(Provider, { store, children: createElement(StaticRouter, { location: '/section?tab=details', context },
        createElement(ProtectedRoute, { name: 'section', path: '/section', render: () => createElement(Section) })) }));
    return { html, context };
}

describe('Отложенная загрузка защищённых разделов', () => {
    it('Не начинает загрузку при регистрации маршрута и до открытия разрешённой страницы', () => {
        const load = vi.fn(() => new Promise<never>(() => {}));
        const Section = lazySection(load, 'Проверка');
        expect(load).not.toHaveBeenCalled();
        expect(renderSection(Section, null).html).toBe('');
        expect(load).not.toHaveBeenCalled();
    });

    it('Отказ в маршруте не показывает fallback и не запрашивает код раздела', () => {
        const load = vi.fn(() => new Promise<never>(() => {}));
        const Section = lazySection(load, 'Проверка');
        const denied = { ...auth, user: { ...auth.user, routePermissions: ['other-section'] } };
        const result = renderSection(Section, denied);
        expect(result.context.url).toBe('/not-allowed');
        expect(result.html).not.toContain('Загружаем раздел');
        expect(load).not.toHaveBeenCalled();
    });

    it('Подтверждённая сессия с пустыми правами получает отказ, а не пустую страницу', () => {
        const load = vi.fn(() => new Promise<never>(() => {}));
        const Section = lazySection(load, 'Проверка');
        const result = renderSection(Section, { ...auth, user: { ...auth.user, routePermissions: [] } });
        expect(result.context.url).toBe('/not-allowed');
        expect(result.html).not.toContain('Загружаем раздел');
        expect(load).not.toHaveBeenCalled();
    });

    it('Неподтверждённая сессия не открывает раздел и не делает преждевременный redirect', () => {
        const load = vi.fn(() => new Promise<never>(() => {}));
        const Section = lazySection(load, 'Проверка');
        const result = renderSection(Section, auth, false);
        expect(result.context.url).toBeUndefined();
        expect(result.html).toBe('');
        expect(load).not.toHaveBeenCalled();
    });

    it('Во время ожидания показывает доступный статус с названием текущего раздела', () => {
        const load = vi.fn(() => new Promise<never>(() => {}));
        const result = renderSection(lazySection(load, 'Обслуживание'));
        expect(load).toHaveBeenCalledOnce();
        expect(result.html).toContain('role="status"');
        expect(result.html).toContain('aria-live="polite"');
        expect(result.html).toContain('Обслуживание');
        expect(result.html).toContain('Загружаем раздел');
    });

    it('После готовности показывает страницу вместо бесконечного индикатора', async () => {
        const loaded = Promise.resolve({ default: () => createElement('p', null, 'Содержимое раздела') });
        const load = vi.fn(() => loaded);
        const Section = lazySection(load, 'Проверка');
        renderSection(Section);
        await loaded; await Promise.resolve();
        const result = renderSection(Section);
        expect(result.html).toContain('Содержимое раздела');
        expect(result.html).not.toContain('Загружаем раздел');
        expect(load).toHaveBeenCalledOnce();
    });

    it('При ошибке предлагает явную перезагрузку вместо пустого экрана и скрывает упавшее содержимое', () => {
        const reload = vi.fn();
        const boundary = new LazySectionBoundary({ children: createElement('p', null, 'Недоступный раздел'), reload });
        boundary.state = LazySectionBoundary.getDerivedStateFromError();
        const rendered = boundary.render() as ReactElement<{ extra: ReactElement<{ onClick: () => void }> }>;
        const html = renderToStaticMarkup(rendered);
        expect(html).toContain('Не удалось открыть раздел');
        expect(html).toContain('Текущий адрес сохранится');
        expect(html).toContain('Перезагрузить страницу');
        expect(html).not.toContain('Недоступный раздел');
        rendered.props.extra.props.onClick();
        expect(reload).toHaveBeenCalledOnce();
    });

    it('Исправная граница не подменяет содержимое страницы', () => {
        const page = createElement('p', null, 'Открытый раздел');
        const boundary = new LazySectionBoundary({ children: page, reload: vi.fn() });
        expect(boundary.render()).toBe(page);
    });
});
