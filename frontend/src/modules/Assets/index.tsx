import type { ReactNode } from 'react';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { AssetsEntry } from './AssetsEntry';
class AssetsModule extends ModuleBase {
    constructor() {
        super('assets', 'Поставка', baseRoutes.assets);
    }
    getRoute(): ReactNode[] {
        return [<ProtectedRoute key="assets" name="assets" path={baseRoutes.assets} render={() => <AssetsEntry />} />];
    }
}
export default new AssetsModule();
