import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { SKILLS_ROUTE } from '../../features/UserBlock/permissions';

import Skills from './Skills';

/**
 * Функциональный модуль «Скиллы».
 */
export default class SkillModule extends ModuleBase {
    public constructor() {
        super('skills', 'Скиллы', baseRoutes.skills);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="skills" name={SKILLS_ROUTE} path={baseRoutes.skills} render={() => <Skills />} />,
        ];
    }
}
