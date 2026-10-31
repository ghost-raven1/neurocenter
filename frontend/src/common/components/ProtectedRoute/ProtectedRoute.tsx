import { Card } from 'antd';
import { FC } from 'react';
import { useSelector } from 'react-redux';
import { Redirect, Route } from 'react-router-dom';
import { IProtectedRouteProps } from './interfaces';

import { baseRoutes } from '../../../core/baseRoutes';
import { RootState } from '../../../store';

/**
 * Обёртка маршрута: доступность страницы определяется `routePermissions`.
 * До подтверждения сессии ничего не рендерим; загруженный пустой список прав означает отказ.
 *
 * @component
 */
const ProtectedRoute: FC<IProtectedRouteProps> = ({ name, path, render, exact = false }) => {
    const { isAuth, user } = useSelector((state: RootState) => state.userBlock);

    const isAvailableRoute = user?.routePermissions.includes(name) ?? false;

    const routeItem = <Route path={path} exact={exact} render={render} />;

    if (!isAuth || !user) {
        return null;
    }

    if (!isAvailableRoute) {
        return <Redirect to={baseRoutes.notAllowed} />;
    }

    return <Card bordered={false}>{routeItem}</Card>;
};

export default ProtectedRoute;
