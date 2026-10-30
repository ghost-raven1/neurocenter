/** Historical links open the primary wizard; explicit collapse retains their context. */
export function startSetupRequested(search:string):boolean {
    const params=new URLSearchParams(search);
    if(params.get('setup')==='1')return true;
    if(params.get('setup')==='0')return false;
    return params.has('step')||params.get('legacy')==='1'||params.get('addComputer')==='1'||params.has('connect');
}

/** Переход мастера сохраняет выбранный проект, справку и якорь страницы. */
export function startQueryUrl(search: string, update: { step?: number; project?: string; setup?:boolean; addComputer?:boolean }, hash = ''): string {
    const params = new URLSearchParams(search);
    if (update.step !== undefined) { params.set('step', String(update.step));params.set('setupFlow','bridge-first'); }
    if (update.project !== undefined) { params.set('p', update.project); }
    if (update.setup !== undefined) {params.set('setup',update.setup?'1':'0');params.delete('legacy');}
    if (update.addComputer !== undefined) {if(update.addComputer)params.set('addComputer','1');else params.delete('addComputer');}
    return `/start?${params.toString()}${hash}`;
}
