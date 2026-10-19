import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { PROJECT_DETAIL_ROUTE, PROJECT_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Projects = lazySection(() => import('./Projects'), 'Проекты');
const ProjectDetail = lazySection(() => import('./ProjectDetail'), 'Проект');

/**
 * Функциональный модуль «Проекты» (список + карточка).
 */
export default class ProjectModule extends ModuleBase {
    public constructor() {
        super('projects', 'Проекты', baseRoutes.projects);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="projects" name={PROJECT_ROUTE} path={baseRoutes.projects} exact render={() => <Projects />} />,
            <ProtectedRoute key="project-detail" name={PROJECT_DETAIL_ROUTE} path={baseRoutes.projectDetail} render={() => <ProjectDetail />} />,
        ];
    }
}
