import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { RAG_ROUTE } from '../../features/UserBlock/permissions';

import { lazySection } from '../../common/components/LazySection';

const Rag = lazySection(() => import('./Rag'), 'Базы знаний');

/**
 * Функциональный модуль «RAG / develop-индекс».
 */
export default class RagModule extends ModuleBase {
    public constructor() {
        super('rag', 'RAG-индекс', baseRoutes.rag);
    }

    /**
     * Роуты модуля.
     *
     * @returns список компонент-роутов
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="rag" name={RAG_ROUTE} path={baseRoutes.rag} render={() => <Rag />} />,
        ];
    }
}
