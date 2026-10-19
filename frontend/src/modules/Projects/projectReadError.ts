import {isAxiosError} from 'axios';

/** Отозванный доступ или удалённый проект запрещают показывать прежние сведения. */
export function projectReadUnavailable(error:unknown):boolean {
    return isAxiosError(error)&&[403,404].includes(error.response?.status??0);
}
