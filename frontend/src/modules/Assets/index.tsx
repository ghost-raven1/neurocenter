import type { ReactNode } from 'react';
import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { lazySection } from '../../common/components/LazySection';
const Assets=lazySection(()=>import('../../features/AssetSources/AssetSources'),'Поставка');
class AssetsModule extends ModuleBase {
 constructor(){super('assets','Поставка',baseRoutes.assets);}
 getRoute():ReactNode[]{return [<ProtectedRoute key="assets" name="assets" path={baseRoutes.assets} render={()=><Assets/>}/>];}
}
export default new AssetsModule();
