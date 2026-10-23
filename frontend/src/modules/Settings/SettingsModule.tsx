import type { ReactNode } from 'react';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { lazySection } from '../../common/components/LazySection';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { SETTINGS_ROUTE } from '../../features/UserBlock/permissions';
const Content = lazySection(() => import('./Settings'), 'Настройки');
/** Раздел «Настройки» использует текущие права активной роли. */
export default class SettingsModule extends ModuleBase {
    constructor() { super('settings', 'Настройки', baseRoutes.settings); }
    getRoute(): ReactNode[] {
        return [<ProtectedRoute key="settings" name={SETTINGS_ROUTE} path={baseRoutes.settings} render={() => <Content />} />];
    }
}
