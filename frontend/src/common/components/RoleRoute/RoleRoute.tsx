import { Card } from 'antd';
import { FC } from 'react';
import { useSelector } from 'react-redux';
import { Redirect, Route } from 'react-router-dom';
import { IRoleRouteProps } from './interfaces';

import { baseRoutes } from '../../../core/baseRoutes';
import { roleCan } from '../../../features/UserBlock/roles';
import { RootState } from '../../../store';

/**
 * RBAC-обёртка маршрута: доступ определяется АКТИВНОЙ РОЛЬЮ через `roleCan`.
 * Замена ABAC-`ProtectedRoute` для доменов, где доступ описан ролями, а не политиками.
 * Пока роль не загружена — не рендерим; без права — `/not-allowed`.
 *
 * @component
 */
const RoleRoute: FC<IRoleRouteProps> = ({ path, minAction, render, exact = false }) => {
    const user = useSelector((state: RootState) => state.userBlock.user);

    if (user === null) {
        return null;
    }

    if (!roleCan(user.activeRole, minAction)) {
        return <Redirect to={baseRoutes.notAllowed} />;
    }

    return (
        <Card bordered={false}>
            <Route path={path} exact={exact} render={render} />
        </Card>
    );
};

export default RoleRoute;
