import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { ERROR_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const ErrorList = lazySection(() => import('./Error'), 'Ошибки');

/**
 * Функциональный модуль «Ошибки» (AD-O5, res-obs 6.11).
 */
export default class ErrorModule extends ModuleBase {
    public constructor() {
        super('error', 'Ошибки', baseRoutes.error);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [<ProtectedRoute key="error" name={ERROR_ROUTE} path={baseRoutes.error} render={() => <ErrorList />} />];
    }
}
