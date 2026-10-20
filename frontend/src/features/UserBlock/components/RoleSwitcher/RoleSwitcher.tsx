import { Select } from 'antd';
import { FC } from 'react';
import { useSelector } from 'react-redux';

import { useAppDispatch } from '../../../../core/hooks';
import { RootState } from '../../../../store';
import { authSwitchRole } from '../../redux/actions';

/**
 * Переключатель активной роли (меняет routePermissions/policies через BFF).
 *
 * @component
 * @returns Селектор назначенных ролей или текущая роль, если выбора нет
 */
const RoleSwitcher: FC = () => {
    const dispatch = useAppDispatch();
    const { user, processing } = useSelector((state: RootState) => state.userBlock);

    if (!user) {
        return null;
    }

    if (user.userRoles.length < 2) {
        return <span>{user.activeRole}</span>;
    }
    return (
        <Select
            aria-label="Активная роль"
            value={user.activeRole}
            loading={processing}
            disabled={processing}
            style={{ width: '100%' }}
            options={user.userRoles.map((role: string) => ({ label: role, value: role }))}
            onChange={(role: string) => dispatch(authSwitchRole(role))}
        />
    );
};

export default RoleSwitcher;
