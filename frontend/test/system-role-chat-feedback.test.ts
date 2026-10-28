import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {modalAntd,uiNode} from './modal-actions.fixture';

const h=await vi.hoisted(async()=>{
    const {adminSetupHooks}=await import('./admin-setup-hooks.fixture'),{modalUi}=await import('./modal-actions.fixture');
    return {hooks:adminSetupHooks(),ui:modalUi(),enabled:true,ack:true,error:'',recover:vi.fn(),replay:vi.fn(),refresh:vi.fn(),start:vi.fn()};
});
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:h.hooks.state,useRef:h.hooks.ref,useEffect:h.hooks.effect}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner',()=>({useAuthRequestOwner:()=>({scope:'qa-role-feedback'})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability',()=>({useFeatureAvailability:()=>({enabled:h.enabled,reason:'Выключено'})}));
vi.mock('../src/features/SystemRoleChat/api',()=>({roleConversationApi:()=>({})}));
vi.mock('../src/features/SystemRoleChat/ServiceComposer',()=>({ServiceComposer:()=>null}));
vi.mock('../src/features/SystemRoleChat/ServiceTurnContent',()=>({ServiceTurnContent:()=>null}));
vi.mock('../src/features/ChatCommon/ChatLog',()=>({ChatLog:({children}:{children?:import('react').ReactNode})=>createElement('div',null,children)}));
vi.mock('../src/features/SystemRoleChat/useSystemRoleChat',()=>({useSystemRoleChat:()=>({owner:'qa-role-feedback',dialogs:[],detail:undefined,loading:false,busy:false,
    error:h.error,receipt:h.ack?{dialogId:'dialog-one',requestId:'original-request'}:undefined,receiptAgentId:'agent-indexer',canReplay:true,
    recover:h.recover,replay:h.replay,refresh:h.refresh,start:h.start,newDialog:vi.fn(),invalidate:vi.fn(),select:vi.fn(),action:vi.fn()})}));
vi.mock('antd',async()=>modalAntd(h.ui,(await import('react')).createElement));
import {SystemRoleChat} from '../src/features/SystemRoleChat/SystemRoleChat';

const render=()=>{h.hooks.begin();h.ui.nodes=[];const html=renderToStaticMarkup(createElement(SystemRoleChat,{agentId:'agent-indexer',projectId:'prj-one'}));h.hooks.commit();return html;};
beforeEach(()=>{h.hooks.dispose();vi.clearAllMocks();h.enabled=true;h.ack=true;h.error='Соединение не подтвердило исходный запрос. '.repeat(20);});
afterEach(()=>h.hooks.dispose());

it('long lost-ACK feedback uses one notice with full details and keeps exact recovery callbacks visible',()=>{
    const html=render();expect(h.ui.nodes.filter(node=>node.kind==='Alert')).toHaveLength(1);
    expect(html).toContain('Подробности ошибки');expect(html).toContain(h.error);expect(html).toContain('Проверить отправку');expect(html).toContain('Повторить тот же запрос');
    expect(h.ui.nodes.some(node=>node.kind==='Button'&&node.text==='Повторить проверку')).toBe(false);
    uiNode(h.ui,'Button','Проверить отправку').onClick();expect(h.recover).toHaveBeenCalledOnce();expect(h.replay).not.toHaveBeenCalled();expect(h.start).not.toHaveBeenCalled();
});
it('flag OFF retains receipt reads but fences a retained replay handler',()=>{
    render();const retained=uiNode(h.ui,'Button','Повторить тот же запрос').onClick;
    h.enabled=false;render();expect(uiNode(h.ui,'Button','Повторить тот же запрос').disabled).toBe(true);
    retained();expect(h.replay).not.toHaveBeenCalled();uiNode(h.ui,'Button','Проверить отправку').onClick();expect(h.recover).toHaveBeenCalledOnce();
});
it('a history-read error without an unknown admission keeps its own refresh path',()=>{
    h.ack=false;const html=render();expect(html).toContain('Подробности ошибки');
    uiNode(h.ui,'Button','Повторить проверку').onClick();expect(h.refresh).toHaveBeenCalledOnce();expect(h.recover).not.toHaveBeenCalled();expect(h.start).not.toHaveBeenCalled();
});
