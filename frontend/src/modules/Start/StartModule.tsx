import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { START_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Start = lazySection(() => import('./Start'), 'Начало работы');

/**
 * Функциональный модуль «Старт»: стартовая страница панели (приветствие,
 * установка opencode, готовые промпты, активы пользователя).
 */
export default class StartModule extends ModuleBase {
    public constructor() {
        super('start', 'Старт', baseRoutes.start);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="start" name={START_ROUTE} path={baseRoutes.start} render={() => <Start />} />,
        ];
    }
}
