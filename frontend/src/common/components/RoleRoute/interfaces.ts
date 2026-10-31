import { ReactNode } from "react";
import { TAction } from "../../../features/UserBlock/roles";

export interface IRoleRouteProps {
    /** Путь маршрута. */
    path: string;
    /** Минимальное действие RBAC-матрицы, нужное для входа на экран. */
    minAction: TAction;
    /** Рендер страницы. */
    render: (props: unknown) => ReactNode;
    /** Точное совпадение пути. */
    exact?: boolean;
}