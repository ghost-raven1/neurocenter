import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { PACKAGES_ROUTE } from '../../features/UserBlock/permissions';

import Packages from './Packages';

/**
 * Функциональный модуль «MCP-пакеты и плагины».
 */
export default class PackageModule extends ModuleBase {
    public constructor() {
        super('packages', 'MCP-пакеты и плагины', baseRoutes.packages);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="packages" name={PACKAGES_ROUTE} path={baseRoutes.packages} render={() => <Packages />} />,
        ];
    }
}
