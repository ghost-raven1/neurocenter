import { FC, ReactNode } from 'react';
import { useSelector } from 'react-redux';

import { IPolitic } from '../../../core/interfaces';
import { RootState } from '../../../store';

interface IPermissionProps {
    /** Ключ права, наличие которого проверяется. */
    permissionKey: string;
    /** Политика, по которой берутся права. */
    politic: IPolitic;
    /** Дополнительное локальное условие отображения children. */
    isLocalAllowed?: boolean;
    children: ReactNode;
}

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
