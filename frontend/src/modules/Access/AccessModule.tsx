import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { ACCESS_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Access = lazySection(() => import('./Access'), 'Участники и доступ');

/**
 * Функциональный модуль «Доступ».
 */
export default class AccessModule extends ModuleBase {
    public constructor() {
        super('access', 'Доступ', baseRoutes.access);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="access" name={ACCESS_ROUTE} path={baseRoutes.access} render={() => <Access />} />,
        ];
    }
}
