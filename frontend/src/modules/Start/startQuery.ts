/** Этап подключения из адреса; неизвестный этап открывает начало мастера. */
export function startStep(search: string): number {
    const step = Number(new URLSearchParams(search).get('step') ?? 0);
    return Number.isInteger(step) && step >= 0 && step <= 2 ? step : 0;
}

/** Переход мастера сохраняет выбранный проект, справку и якорь страницы. */
export function startQueryUrl(search: string, update: { step?: number; project?: string }, hash = ''): string {
    const params = new URLSearchParams(search);
    if (update.step !== undefined) { params.set('step', String(update.step)); }
    if (update.project !== undefined) { params.set('p', update.project); }
    return `/start?${params.toString()}${hash}`;
}
