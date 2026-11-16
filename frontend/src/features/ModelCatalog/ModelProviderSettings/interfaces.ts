import type { ICatalogModel } from '../interfaces';

export interface IModelProviderSettingsProps {
    model: ICatalogModel;
    canManage: boolean;
    busy: boolean;
    onConfigure?: () => void;
    /** Единое место ввода ключа: детали ведут в модалку «Мой доступ» (8.19 P1-2). */
    onProviderAccess?: () => void;
}
