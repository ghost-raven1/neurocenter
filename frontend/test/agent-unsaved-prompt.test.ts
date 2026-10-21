import { afterEach, expect, it, vi } from 'vitest';
import { useUnsavedAgentPrompt } from '../src/features/AgentCatalog/useUnsavedAgentPrompt';
const ui=vi.hoisted(()=>({cleanup:undefined as (()=>void)|undefined,block:vi.fn(),unblock:vi.fn()}));
vi.mock('react',()=>({useEffect:(effect:()=>void|(()=>void))=>{ui.cleanup=effect()||undefined;}}));
vi.mock('react-router-dom',()=>({useHistory:()=>({block:ui.block})}));
afterEach(()=>{ui.cleanup?.();ui.cleanup=undefined;vi.unstubAllGlobals();vi.clearAllMocks();});
it('Dirty prompt блокирует навигацию и reload, после закрытия снимает оба обработчика',()=>{
    const browser=new EventTarget();vi.stubGlobal('window',browser);ui.block.mockReturnValue(ui.unblock);useUnsavedAgentPrompt(true);
    expect(ui.block).toHaveBeenCalledWith('Промпт изменён и ещё не сохранён. Покинуть редактор?');
    const before=new Event('beforeunload',{cancelable:true});browser.dispatchEvent(before);expect(before.defaultPrevented).toBe(true);
    ui.cleanup!();ui.cleanup=undefined;expect(ui.unblock).toHaveBeenCalledOnce();const after=new Event('beforeunload',{cancelable:true});browser.dispatchEvent(after);expect(after.defaultPrevented).toBe(false);
});
it('Сохранённая форма не просит подтверждения навигации',()=>{
    vi.stubGlobal('window',new EventTarget());useUnsavedAgentPrompt(false);expect(ui.block).not.toHaveBeenCalled();expect(ui.cleanup).toBeUndefined();
});
