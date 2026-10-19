import { ReactNode } from 'react';

/**
 * Элемент меню навигации.
 */
export interface IMenuItem {
    name: string;
    route: string;
    title: string;
}

/**
 * ABAC-политика фичи (имя политики возвращается BFF в /auth/me).
 */
export interface IPolitic {
    politicName: string;
}

/**
 * Базовые поля сущности каталога.
 */
export interface ICatalogBase {
    id: string;
    name: string;
    createdAt: string;
}

/**
 * Информация о пользователе после входа (результат GET /auth/me).
 */
export interface IUserInfo {
    id: string;
    principalName: string;
    email: string;
    projectRoles: Array<{projectId:string;projectName:string;role:string}>;
    displayName: string;
    userRoles: string[];
    activeRole: string;
    routePermissions: string[];
}

/**
 * Ответ GET /auth/me.
 */
export interface IAuthMe {
    user: IUserInfo;
    policies: Record<string, string[]>;
}

/**
 * Базовый контракт функционального модуля приложения.
 */
export interface IModule {
    name: string;
    title: string;
    route: string;
    getRoute: () => ReactNode[];
    getStructure: () => IMenuItem[];
}
