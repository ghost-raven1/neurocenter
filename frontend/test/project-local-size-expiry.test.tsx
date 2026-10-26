// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {IBridgeDevice} from '../src/features/McpBridge/api';
import {ProjectFolderDataSize} from '../src/modules/Projects/features/ProjectSize/ProjectFolderDataSize';

const now=Date.parse('2026-10-26T02:00:00.000Z');
let root:Root,container:HTMLDivElement;
const device=(bytes=2048):IBridgeDevice=>({id:'computer-a',name:'Мой компьютер',role:'Разработчик',fingerprint:'',online:true,lastSeen:new Date(now).toISOString(),report:{capabilities:['project-data-size-v1'],bindings:[{
    projectId:'prj-a',folderName:'bank',valid:true,identityStatus:'verified',bindingId:'a'.repeat(64),instanceId:'12345678-1234-1234-1234-123456789abc',
    dataSize:{scope:'opencode',bytes,measuredAt:new Date(now-59000).toISOString()},
}]}});
const refresh=vi.fn();
function render(canRead=true,current=device()){
    act(()=>root.render(createElement(ProjectFolderDataSize,{project:{id:'prj-a',logicalBytes:null},bridge:{device:current,devices:[current],devicesReady:true,loading:false},
        canRead,canBind:true,title:'Данные проекта',loading:false,onRetry:refresh})));
}
beforeEach(()=>{
    vi.useFakeTimers();vi.setSystemTime(now);refresh.mockReset();
    (globalThis as unknown as {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(()=>{act(()=>root.unmount());container.remove();vi.useRealTimers();});

it('скрывает истёкший размер без ожидания следующего сетевого опроса',async()=>{
    render();expect(container.textContent).toContain('2 КБ');
    await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
    expect(container.textContent).toContain('Замер устарел');expect(container.textContent).not.toContain('2 КБ');expect(refresh).not.toHaveBeenCalled();
});
it('отзыв права чтения скрывает размер и отменяет его таймер',async()=>{
    render();render(false);expect(container.textContent).toContain('Нет доступа');
    await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
    expect(container.textContent).not.toContain('2 КБ');expect(container.textContent).not.toContain('Замер устарел');expect(refresh).not.toHaveBeenCalled();
});
