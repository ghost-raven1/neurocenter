import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { STORE_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Store = lazySection(() => import('./Store'), 'Каталог инструментов');

/**
 * Функциональный модуль «Магазин» — витрина приложений (скиллы/MCP/плагины)
 * в стиле app-store: общая витрина + магазин конкретного проекта,
 * установка в один клик.
 */
export default class StoreModule extends ModuleBase {
    public constructor() {
        super('store', 'Магазин', baseRoutes.store);
    }

    /**
     * Роуты модуля (чтение доступно всем ролям; действия гейтятся в UI).
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="store" name={STORE_ROUTE} path={baseRoutes.store} render={() => <Store />} />,
        ];
    }
}
