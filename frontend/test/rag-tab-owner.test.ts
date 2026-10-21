import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import RagTab from '../src/modules/Projects/components/RagTab';
import bffApi from '../src/core/api/bff';
import type {IRagSummary} from '../src/core/api/interfaces';

const hooks=vi.hoisted(()=>{
    let cursor=0;const slots:Array<{value?:unknown;deps?:unknown[];cleanup?:()=>void}>=[],effects:Array<()=>void>=[];
    const same=(a:unknown[]|undefined,b:unknown[])=>a?.length===b.length&&b.every((value,index)=>Object.is(value,a[index]));
    return{begin:()=>{cursor=0;},commit:()=>effects.splice(0).forEach(effect=>effect()),dispose:()=>{slots.splice(0).forEach(slot=>slot.cleanup?.());effects.length=0;},
        state:(initial:unknown)=>{const slot=slots[cursor++]??={value:initial};return[slot.value,(value:unknown)=>{slot.value=typeof value==='function'?value(slot.value):value;}];},
        ref:(value:unknown)=>(slots[cursor++]??={value:{current:value}}).value,
        callback:(value:unknown,deps:unknown[])=>{const i=cursor++,old=slots[i];if(old&&same(old.deps,deps))return old.value;slots[i]={value,deps};return value;},
        effect:(effect:()=>void|(()=>void),deps:unknown[])=>{const i=cursor++,old=slots[i];if(old&&same(old.deps,deps))return;const slot=slots[i]={deps};effects.push(()=>{old?.cleanup?.();slot.cleanup=effect()||undefined;});}};
});
const ui=vi.hoisted(()=>({owner:'alice',refresh:()=>{},captures:new Map<string,()=>()=>boolean>()}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:hooks.state,useRef:hooks.ref,useCallback:hooks.callback,useEffect:hooks.effect}));
vi.mock('react-redux',()=>({useSelector:()=>({activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>{const owner=ui.owner;let capture=ui.captures.get(owner);if(!capture){capture=()=>()=>owner===ui.owner;ui.captures.set(owner,capture);}return{scope:owner,captureOwner:capture};}}));
vi.mock('../src/core/socket/useSectionUpdates',()=>({useSectionUpdates:(_sections:string[],refresh:()=>void)=>{ui.refresh=refresh;}}));
vi.mock('../src/core/api/bff',()=>({default:{getRagSummary:vi.fn()}}));
vi.mock('../src/features/McpBridge/KnowledgeSync',()=>({KnowledgeSync:()=>null}));
vi.mock('../src/features/ProjectEmbedding/ProjectEmbedding',()=>({ProjectEmbedding:()=>null}));
vi.mock('../src/modules/Projects/features/RagQuota/RagQuotaMeter',()=>({RagQuotaMeter:()=>null}));
vi.mock('antd',()=>{const content=({children}:{children?:ReactNode})=>children;return{Alert:({message,description}:{message:string;description?:string})=>createElement('p',{role:'alert'},message,description),Typography:{Text:content,Paragraph:content},Space:content,Row:content,Col:content,Card:content,Spin:content,Button:content,Statistic:({title,value}:{title:string;value:string|number})=>createElement('p',null,title,': ',value)};});
const summary:IRagSummary={projectKey:'prj-one',rowCount:17,dimension:2560,lastSyncedAt:null};
function render(commit=true){hooks.begin();const html=renderToStaticMarkup(createElement(RagTab,{projectKey:'prj-one'}));if(commit)hooks.commit();return html;}
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
beforeEach(()=>{hooks.dispose();vi.clearAllMocks();ui.owner='alice';ui.captures.clear();vi.mocked(bffApi.getRagSummary).mockResolvedValue(summary);});
afterEach(()=>hooks.dispose());

describe('Сводка знаний принадлежит текущему проекту и профилю',()=>{
    it('Смена владельца до React cleanup не принимает поздний успешный ответ',async()=>{const request=deferred<IRagSummary>();vi.mocked(bffApi.getRagSummary).mockReturnValueOnce(request.promise);render();ui.owner='bob';request.resolve(summary);await flush();expect(render(false)).not.toContain('Фрагментов: 17');});
    it('Live reread обновляет сведения без ручной кнопки',async()=>{render();await flush();expect(render()).toContain('Фрагментов: 17');vi.mocked(bffApi.getRagSummary).mockResolvedValue({...summary,rowCount:18});ui.refresh();await flush();expect(render()).toContain('Фрагментов: 18');});
    it('Сетевой отказ сохраняет последнюю сводку с предупреждением и рабочим retry',async()=>{render();await flush();render();vi.mocked(bffApi.getRagSummary).mockRejectedValueOnce(new Error('Нет соединения'));ui.refresh();await flush();const html=render();expect(html).toContain('Фрагментов: 17');expect(html).toContain('показаны последние данные');expect(html).toContain('Нет соединения');});
    it('Отказ в доступе очищает прежнюю сводку, а не выдаёт её за доступные данные',async()=>{render();await flush();render();vi.mocked(bffApi.getRagSummary).mockRejectedValueOnce({isAxiosError:true,response:{status:403}});ui.refresh();await flush();expect(render()).not.toContain('Фрагментов: 17');});
});
