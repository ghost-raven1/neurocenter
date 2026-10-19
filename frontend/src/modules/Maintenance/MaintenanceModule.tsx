import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { MAINTENANCE_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Maintenance = lazySection(() => import('./Maintenance'), 'Обслуживание');

/**
 * Функциональный модуль «Обслуживание».
 */
export default class MaintenanceModule extends ModuleBase {
    public constructor() {
        super('maintenance', 'Обслуживание', baseRoutes.maintenance);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="maintenance" name={MAINTENANCE_ROUTE} path={baseRoutes.maintenance} render={() => <Maintenance />} />,
        ];
    }
}
