import { Redirect, useLocation } from 'react-router-dom';
import { lazySection } from '../../common/components/LazySection';
import { useCatalogSuppliesAccess } from '../../features/AssetSources/hooks/useCatalogSuppliesAccess';
import { catalogSectionUrl } from '../Store/catalogSection';
import { baseRoutes } from '../../core/baseRoutes';
const Assets = lazySection(() => import('../../features/AssetSources/AssetSources'), 'Поставка');
/** Existing links remain readable when the catalog permission or navigation flag is unavailable. */
export function AssetsEntry(): JSX.Element {
    const location = useLocation(),
        { integrated } = useCatalogSuppliesAccess();
    return integrated ? (
        <Redirect to={catalogSectionUrl(baseRoutes.store, location.search, 'supplies', false, location.hash)} />
    ) : (
        <Assets />
    );
}
