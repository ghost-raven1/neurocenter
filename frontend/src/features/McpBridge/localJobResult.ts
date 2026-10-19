import type { IBridgeJob } from './api';

/** Повторный объект из polling/WS не переустанавливает preview и не сбрасывает согласие пользователя. */
export function consumeLocalJobResult(seen:Set<string>,job:Pick<IBridgeJob,'id'|'state'>|undefined,context:string,expectedContext:string|undefined):boolean {
    if(!job||job.state!=='succeeded'||context!==expectedContext||seen.has(job.id)){return false;}
    seen.add(job.id);return true;
}
