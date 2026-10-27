/** Этап подключения из адреса; неизвестный этап открывает начало мастера. */
export function startStep(search: string): number {
    const step = Number(new URLSearchParams(search).get('step') ?? 0);
    return Number.isInteger(step) && step >= 0 && step <= 2 ? step : 0;
}

/** The primary flow owns /start; explicit historical links retain their original recovery owner. */
export function legacyStartRequested(search:string):boolean {
    const params=new URLSearchParams(search);
    return params.get('setup')!=='1'&&(params.has('addComputer')||params.get('legacy')==='1'||startStep(search)>0);
}

/** Переход мастера сохраняет выбранный проект, справку и якорь страницы. */
export function startQueryUrl(search: string, update: { step?: number; project?: string; setup?:boolean }, hash = ''): string {
    const params = new URLSearchParams(search);
    if (update.step !== undefined) { params.set('step', String(update.step)); }
    if (update.project !== undefined) { params.set('p', update.project); }
    if (update.setup !== undefined) {if(update.setup)params.set('setup','1');else params.delete('setup');}
    return `/start?${params.toString()}${hash}`;
}
