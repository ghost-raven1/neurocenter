import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { AUDIT_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Audit = lazySection(() => import('./Audit'), 'История действий');

/**
 * Функциональный модуль «Аудит».
 */
export default class AuditModule extends ModuleBase {
    public constructor() {
        super('audit', 'Аудит', baseRoutes.audit);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="audit" name={AUDIT_ROUTE} path={baseRoutes.audit} render={() => <Audit />} />,
        ];
    }
}
