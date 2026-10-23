import type { ReactNode } from 'react';
import {Redirect, useLocation} from 'react-router-dom';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { lazySection } from '../../common/components/LazySection';
const ModelUsage = lazySection(() => import('../../features/ModelUsage/ModelUsagePage'), 'Использование моделей');
function UsageAlias(): JSX.Element {const location = useLocation(); return <Redirect to={baseRoutes.modelUsage + location.search + location.hash}/>;}
class ModelUsageModule extends ModuleBase {
    constructor() { super('model-usage', 'Использование моделей', baseRoutes.modelUsage); }
    getRoute(): ReactNode[] { return [<ProtectedRoute key="model-usage" name="model-usage" path={baseRoutes.modelUsage} render={() => <ModelUsage />} />, <ProtectedRoute key="modal-usage-alias" name="model-usage" path="/modal-usage" render={() => <UsageAlias/>}/>]; }
}
export default new ModelUsageModule();
