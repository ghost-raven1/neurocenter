import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { OPERATIONS_ROUTE } from '../../features/UserBlock/permissions';

import Operations from './Operations';

/**
 * Функциональный модуль «Передачи и проверки».
 */
export default class OperationModule extends ModuleBase {
    public constructor() {
        super('operations', 'Передачи и проверки', baseRoutes.operations);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="operations" name={OPERATIONS_ROUTE} path={baseRoutes.operations} render={() => <Operations />} />,
        ];
    }
}
