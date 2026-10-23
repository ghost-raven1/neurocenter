import type { ReactNode } from 'react';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { lazySection } from '../../common/components/LazySection';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { HELP_ROUTE } from '../../features/UserBlock/permissions';
const Content = lazySection(() => import('./Help'), 'Помощь');
/** Раздел «Помощь» использует текущие права активной роли. */
export default class HelpModule extends ModuleBase {
    constructor() { super('help', 'Помощь', baseRoutes.help); }
    getRoute(): ReactNode[] {
        return [<ProtectedRoute key="help" name={HELP_ROUTE} path={baseRoutes.help + '/:slug?'} render={() => <Content />} />];
    }
}
