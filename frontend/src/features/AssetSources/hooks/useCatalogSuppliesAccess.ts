import { useSelector } from 'react-redux';
import type { TRootState } from '../../../store';
import { canReadCatalogSources } from '../catalogSourceStatus';
import { useFeatureAvailability } from '../../FeatureFlags/FeatureAvailability';
/** Navigation permission never grants source access or changes the existing write flags. */
export function useCatalogSuppliesAccess() {
    const sourcePermission = useSelector(
        (state: TRootState) =>
            canReadCatalogSources(state) && !!state.userBlock.user?.routePermissions.includes('assets'),
    );
    const storePermission = useSelector(
        (state: TRootState) => !!state.userBlock.user?.routePermissions.includes('store'),
    );
    const availability = useFeatureAvailability('catalog_supplies_navigation');
    return { sourcePermission, integrated: sourcePermission && storePermission && availability.enabled };
}
