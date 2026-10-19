import { Select, Tag, Tooltip } from 'antd';
import { FC } from 'react';
import { useSelector } from 'react-redux';

import { useAppDispatch } from '../../../../core/hooks';
import { RootState } from '../../../../store';
import { authSwitchRole } from '../../redux/actions';

/**
 * Переключатель активной роли (меняет routePermissions/policies через BFF).
 *
 * @component
 * @returns JSX-элемент селектора ролей или null, если роль одна
 */
const RoleSwitcher: FC = () => {
    const dispatch = useAppDispatch();
    const { user, processing } = useSelector((state: RootState) => state.userBlock);

    if (!user) {
        return null;
    }

    if (user.userRoles.length < 2) {
        return <Tooltip title="Активная роль"><Tag color="cyan" style={{margin:0}}>{user.activeRole}</Tag></Tooltip>;
    }
    return (
        <Select
            aria-label="Активная роль"
            value={user.activeRole}
            loading={processing}
            disabled={processing}
            style={{ minWidth: 160 }}
            options={user.userRoles.map((role: string) => ({ label: role, value: role }))}
            onChange={(role: string) => dispatch(authSwitchRole(role))}
        />
    );
};

export default RoleSwitcher;
