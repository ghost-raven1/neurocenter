import { FC } from 'react';
import { useSelector } from 'react-redux';
import { IPermissionProps } from './interfaces';

import { RootState } from '../../../store';

/**
 * Обёртка-гейт ABAC: рендерит children только при наличии `permissionKey`
 * в разрешённых правах политики `politic` (источник — `UserBlock.policies`).
 *
 * @component
 */
const Permission: FC<IPermissionProps> = ({ permissionKey, politic, isLocalAllowed, children }) => {
    const permissions = useSelector((state: RootState) => state.userBlock.policies[politic.politicName]) as
        string[] | undefined;

    const hasMainPermission = (permissions ?? []).includes(permissionKey);

    const isAllowed = typeof isLocalAllowed === 'boolean'
        ? hasMainPermission && isLocalAllowed
        : hasMainPermission;

    if (!isAllowed) {
        return null;
    }

    return <>{children}</>;
};

export default Permission;
