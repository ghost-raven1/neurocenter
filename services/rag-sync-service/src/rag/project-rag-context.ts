import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { normalizeIndexProfile, type IIndexProfile } from '../../../shared/rag-index-contract.cjs';

export interface IProjectRagContext {projectId:string;revision:number;dataRevision:number;generation:string;profile:IIndexProfile|null;snapshot:string|null;}
/** Чтение никогда не выбирает generation локально: один authoritative pointer принадлежит каталогу. */
export async function projectRagContext(projectId:string):Promise<IProjectRagContext>{
    const base=(process.env.CATALOG_SERVICE_URL||'http://localhost:4100').replace(/\/+$/,'');
    const response=await fetch(`${base}/internal/project-rag/context/${encodeURIComponent(projectId)}`,{headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''},signal:AbortSignal.timeout(8000)})
        .catch(()=>{throw new ServiceUnavailableException('Не удалось прочитать активный индекс проекта.');});
    if(!response.ok)throw new ServiceUnavailableException('Каталог не подтвердил активный индекс проекта.');
    const body=await response.json() as IProjectRagContext;
    if(body.projectId!==projectId||typeof body.generation!=='string'||!/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.test(body.generation)
        ||!Number.isSafeInteger(body.revision)||body.revision<0||!Number.isSafeInteger(body.dataRevision)||body.dataRevision<0)throw new ConflictException('Контекст индекса повреждён.');
    return {...body,profile:normalizeIndexProfile(body.profile)};
}
