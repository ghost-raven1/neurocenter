/** Ошибка чтения карточки: отсутствие/отказ доступа отличаются от временного сбоя. */
export interface IProjectLoadError {
    status: number | null;
    message: string;
}
