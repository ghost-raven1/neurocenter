import type { ICatalogModel } from '../interfaces';

export interface IModelProviderSettingsProps {
    model: ICatalogModel;
    canManage: boolean;
    busy: boolean;
    onConfigure?: () => void;
}
