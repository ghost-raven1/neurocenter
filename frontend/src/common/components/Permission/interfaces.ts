import { ReactNode } from "react";
import { IPolitic } from "../../../core/interfaces";

export interface IPermissionProps {
    /** Ключ права, наличие которого проверяется. */
    permissionKey: string;
    /** Политика, по которой берутся права. */
    politic: IPolitic;
    /** Дополнительное локальное условие отображения children. */
    isLocalAllowed?: boolean;
    children: ReactNode;
}