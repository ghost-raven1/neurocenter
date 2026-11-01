import { Alert } from 'antd';
import { Redirect, useLocation } from 'react-router-dom';
import { lazySection } from '../../common/components/LazySection';
import { useCatalogSuppliesAccess } from '../../features/AssetSources/hooks/useCatalogSuppliesAccess';
import { baseRoutes } from '../../core/baseRoutes';
const Assets = lazySection(
    () =>
        import('../../features/AssetSources/AssetSources').then(({ default: AssetSources }) => ({
            default: () => <AssetSources embedded />,
        })),
    'Поставка',
);
/** Only the existing global source owner can open supplies inside any catalog context. */
export function CatalogSupplies(): JSX.Element {
    const location = useLocation(),
        { sourcePermission, integrated } = useCatalogSuppliesAccess();
    if (!sourcePermission)
        return (
            <Alert type="warning" message="Поставки доступны главному администратору с правом просмотра источников." />
        );
    if (!integrated) return <Redirect to={baseRoutes.assets + location.search + location.hash} />;
    return <Assets />;
}
