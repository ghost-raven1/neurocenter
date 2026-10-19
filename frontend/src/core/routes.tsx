import { Redirect, Route, Switch } from 'react-router-dom';
import type { ReactNode } from 'react';

import NotAllowedPage from '../common/components/NotAllowedPage';
import NotFoundPage from '../common/components/NotFoundPage';
import type { IMenuItem, IModule } from './interfaces';
import Core from '../modules/Core';
import { contentModules } from '../modules';
import { baseRoutes } from './baseRoutes';
import LegacyOperationsRedirect from '../modules/Operations/LegacyOperationsRedirect';

/**
 * Собирает компоненты роутов всех модулей.
 *
 * @param {IModule[]} modules - список модулей
 * @returns список элементов роутов
 */
const getRoutes = (modules: IModule[]): ReactNode[] => modules.flatMap(module => module.getRoute());

/**
 * Собирает пункты меню всех модулей.
 *
 * @param {IModule[]} modules - список модулей
 * @returns список пунктов меню
 */
const getStructure = (modules: IModule[]): IMenuItem[] => modules.flatMap(module => module.getStructure());

/**
 * Компонент маршрутизации: оболочка Core + роуты модулей + 403/404.
 *
 * @component
 * @returns JSX-элемент маршрутизатора
 */
const Router: React.FC = () => {
    const structure = getStructure(contentModules);
    const routes = getRoutes(contentModules);

    return (
        <Core modulesStructure={structure}>
            <Switch>
                {routes}
                <Route exact path={baseRoutes.operations} component={LegacyOperationsRedirect} />
                <Route exact path={baseRoutes.home}>
                    <Redirect to={baseRoutes.start} />
                </Route>
                <Route exact path={baseRoutes.notAllowed} component={NotAllowedPage} />
                <Route path={baseRoutes.notFound} component={NotFoundPage} />
            </Switch>
        </Core>
    );
};

export default Router;
