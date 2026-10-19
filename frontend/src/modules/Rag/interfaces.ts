/** Ошибка чтения отделена от успешного пустого списка. */
export interface IRagLoadError {
    status: number | null;
    message: string;
}
