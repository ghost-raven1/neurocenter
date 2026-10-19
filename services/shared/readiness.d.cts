export interface IReadiness {ok:boolean;checks:Record<string,'ready'|'unavailable'>}
/** Ограниченная по времени проверка зависимостей без раскрытия секретов. */
export function checkReadiness(checks:Record<string,()=>Promise<unknown>>):Promise<IReadiness>;
export function httpReady(base:string):Promise<void>;
