// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {globalProvidersPage} from '../../mcp/neurocenter-asset-sync/src/features/opencode-local-providers/page';

afterEach(()=>{document.body.replaceChildren();vi.unstubAllGlobals();});
it('reading an older saved intent cannot erase a newly entered private credential draft',async()=>{
    const fetch=vi.fn(async(route:string)=>Response.json(route==='/session'?{csrf:'synthetic-csrf'}:{inventory:{providers:[],issues:[]},lastSave:{intentId:'old-saved-id',providerId:'openai',status:'saved'}}));
    vi.stubGlobal('fetch',fetch);document.body.innerHTML=globalProvidersPage;const script=globalProvidersPage.match(/<script>([\s\S]*?)<\/script>/)![1];
    new Function(script)();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));await new Promise(done=>setTimeout(done,0));
    const key=document.querySelector<HTMLInputElement>('#key')!;key.value='SYNTHETIC_NEW_UNSAVED_KEY';key.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector<HTMLButtonElement>('#refresh')!.click();
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));await new Promise(done=>setTimeout(done,0));expect(key.value).toBe('SYNTHETIC_NEW_UNSAVED_KEY');
});
