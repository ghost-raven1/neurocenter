import type { IMenuItem } from '../../core/interfaces';

export const navigationGroups = [
    { key: 'work', title: 'Работа' },
    { key: 'resources', title: 'Ресурсы' },
    { key: 'management', title: 'Управление' },
    { key: 'help', title: 'Справка' },
] as const;
export type TNavigationGroupKey = (typeof navigationGroups)[number]['key'];
export interface INavigationEntry extends IMenuItem {
    group: TNavigationGroupKey | null;
    external?: boolean;
}

const sections: Record<string, { title: string; group: TNavigationGroupKey | null }> = {
    start: { title: 'Начало работы', group: null },
    projects: { title: 'Проекты', group: 'work' },
    rag: { title: 'Базы знаний', group: 'work' },
    store: { title: 'Каталог', group: 'resources' },
    assets: { title: 'Поставка', group: 'resources' },
    maintenance: { title: 'Обслуживание', group: 'management' },
    audit: { title: 'История действий', group: 'management' },
    'model-usage': { title: 'Использование моделей', group: 'management' },
    access: { title: 'Участники и доступ', group: 'management' },
    settings: { title: 'Настройки', group: 'management' },
    help: { title: 'Помощь', group: 'help' },
};

/** Group only already-authorized routes; future modules remain reachable in the work section. */
export function navigationEntries(structure: IMenuItem[], permissions: readonly string[]): INavigationEntry[] {
    return [
        ...structure
            .filter((item) => permissions.includes(item.name))
            .map((item) => ({
                ...item,
                title: sections[item.name]?.title ?? item.title,
                group: sections[item.name]?.group ?? (item.name === 'start' ? null : 'work'),
            })),
        { name: 'api-docs', route: '/api/docs', title: 'Swagger API', group: 'help', external: true },
    ];
}

/** A nested route selects its longest authorized parent, never a similarly prefixed route. */
export function selectedNavigationEntry(entries: INavigationEntry[], pathname: string): INavigationEntry | undefined {
    return entries
        .filter((item) => !item.external && (pathname === item.route || pathname.startsWith(item.route + '/')))
        .sort((left, right) => right.route.length - left.route.length)[0];
}
