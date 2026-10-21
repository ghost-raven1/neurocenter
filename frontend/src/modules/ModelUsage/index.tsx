import type { ReactNode } from 'react';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { lazySection } from '../../common/components/LazySection';
const ModelUsage = lazySection(() => import('../../features/ModelUsage/ModelUsagePage'), 'Использование моделей');
class ModelUsageModule extends ModuleBase {
    constructor() { super('model-usage', 'Использование моделей', baseRoutes.modelUsage); }
    getRoute(): ReactNode[] { return [<ProtectedRoute key="model-usage" name="model-usage" path={baseRoutes.modelUsage} render={() => <ModelUsage />} />]; }
}
export default new ModelUsageModule();
