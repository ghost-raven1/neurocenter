import { Redirect, useLocation } from 'react-router-dom';
import { lazySection } from '../../common/components/LazySection';
import { useCatalogSuppliesAccess } from '../../features/AssetSources/hooks/useCatalogSuppliesAccess';
import { catalogSectionUrl } from '../Store/catalogSection';
import { FeatureAvailabilityNotice, useFeatureAvailability } from '../../features/FeatureFlags/FeatureAvailability';
import { baseRoutes } from '../../core/baseRoutes';
const Assets = lazySection(() => import('../../features/AssetSources/AssetSources'), 'Поставка');
/** Existing links remain readable when the catalog permission or navigation flag is unavailable. */
export function AssetsEntry(): JSX.Element {
    const location = useLocation(),
        { integrated } = useCatalogSuppliesAccess(),
        navigation = useFeatureAvailability('catalog_supplies_navigation');
    // Decide the destination before mounting a screen that consumes one-shot URL intent.
    if (!navigation.known && new URLSearchParams(location.search).get('archive') === 'open')
        return <FeatureAvailabilityNotice features={['catalog_supplies_navigation']} />;
    return integrated ? (
        <Redirect to={catalogSectionUrl(baseRoutes.store, location.search, 'supplies', false, location.hash)} />
    ) : (
        <Assets />
    );
}
