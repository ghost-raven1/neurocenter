import { ReactNode } from 'react';

import type { IMenuItem } from '../interfaces';

/**
 * Базовый класс функционального модуля панели.
 * Потомки описывают свои роуты (`getRoute`) и пункт меню (`getStructure`).
 */
export abstract class ModuleBase {
    public name: string;

    public title: string;

    public route: string;

    constructor(name: string, title: string, route: string) {
        this.name = name;
        this.title = title;
        this.route = route;
    }

    /**
     * Возвращает компоненты Роутов модуля.
     *
     * @returns список элементов `<ProtectedRoute>`
     */
    public abstract getRoute(): ReactNode[];

    /**
     * Возвращает пункт(ы) меню навигации.
     *
     * @returns список элементов меню
     */
    public getStructure(): IMenuItem[] {
        return [{ name: this.name, route: this.route, title: this.title }];
    }
}
