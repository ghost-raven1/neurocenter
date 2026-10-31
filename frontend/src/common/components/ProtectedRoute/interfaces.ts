import { ReactNode } from 'react';

export interface IProtectedRouteProps {
    /** Имя маршрута для проверки в `routePermissions`. */
    name: string;
    /** Путь маршрута. */
    path: string;
    /** Рендер страницы. */
    render: (props: unknown) => ReactNode;
    exact?: boolean;
}