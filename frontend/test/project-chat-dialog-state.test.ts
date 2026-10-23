import {harness,ui} from './project-chat-ui-fixture';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useProjectChat} from '../src/features/ProjectChat/useProjectChat';
import {useProjectChatRooms} from '../src/features/ProjectChat/useProjectChatRooms';
import {projectChatApi} from '../src/features/ProjectChat/api';
import {projectMessage,projectRoom} from './project-chat-fixtures';
import {DEFAULT_PROJECT_CHAT_ROOM,type ProjectChatDetail,type ProjectChatRooms} from '../src/features/ProjectChat/types';
vi.mock('../src/features/ProjectChat/api',()=>({projectChatApi:{read:vi.fn(),history:vi.fn(),send:vi.fn(),retry:vi.fn(),cancel:vi.fn(),participants:vi.fn(),rooms:vi.fn(),createRoom:vi.fn(),updateRoom:vi.fn()}}));
const id='115af965-9952-402f-8811-20ae55f47991',other='59bc418a-8760-4b4b-ae66-eb16713c2255';
const detail=(roomId=id):ProjectChatDetail=>projectRoom({room:{...projectRoom().room,id:roomId,visibility:'PRIVATE',title:'SECRET TITLE'},messages:[projectMessage({roomId,content:'SECRET MESSAGE'})]});
const list:ProjectChatRooms={canCreate:true,members:[],rooms:[{id:DEFAULT_PROJECT_CHAT_ROOM,title:'Общий чат',visibility:'PUBLIC',revision:1,updatedAt:'2026-10-23T00:00:00Z',canManage:false,memberEmails:[]},{id,title:'SECRET TITLE',visibility:'PRIVATE',revision:2,updatedAt:'2026-10-23T00:00:00Z',canManage:true,memberEmails:['alice@example.test']}]};
const flush=async()=>{for(let index=0;index<30;index++)await Promise.resolve();};
const render=(roomId=id)=>{harness.begin();const value=useProjectChat('prj-one',roomId);harness.commit();return value;};
const renderRooms=()=>{harness.begin();const value=useProjectChatRooms('prj-one');harness.commit();return value;};
const defer=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return{promise,resolve};};
beforeEach(()=>{vi.clearAllMocks();ui.owner='alice';ui.scope='alice';vi.stubGlobal('document',{visibilityState:'visible'});vi.mocked(projectChatApi.read).mockResolvedValue(detail());vi.mocked(projectChatApi.rooms).mockResolvedValue(list);});
afterEach(()=>{harness.dispose();vi.unstubAllGlobals();});
describe('Private dialogue response ownership',()=>{
    it('every poll carries its exact room and an unrelated room response is discarded',async()=>{
        render();await flush();const chat=render();expect(chat.detail?.messages[0].content).toBe('SECRET MESSAGE');expect(vi.mocked(projectChatApi.read).mock.calls[0][3]).toBe(id);
        vi.mocked(projectChatApi.read).mockResolvedValueOnce(detail(other));await chat.refresh();expect(render().detail?.room.id).toBe(id);
    });
    it('switching room on the same hook discards a held old response before the next render effect can accept it',async()=>{
        render();await flush();const previous=render(),held=defer<ProjectChatDetail>();vi.mocked(projectChatApi.read).mockReturnValueOnce(held.promise);const pending=previous.refresh();
        vi.mocked(projectChatApi.read).mockResolvedValue(detail(other));render(other);await flush();expect(render(other).detail?.room.id).toBe(other);
        held.resolve(detail(id));await pending;expect(render(other).detail?.room.id).toBe(other);expect(render(other).detail?.messages[0].roomId).toBe(other);
    });
    it('a denied send clears the private snapshot immediately instead of waiting for the next poll',async()=>{
        render();await flush();vi.mocked(projectChatApi.send).mockRejectedValueOnce({isAxiosError:true,response:{status:404}});await expect(render().send({requestKey:'key',prompt:'Question'})).rejects.toBeDefined();expect(render().detail).toBeUndefined();expect(render().accessDenied).toBe(true);
    });
    it('a fresh denied send invalidates an older authorized GET before the parent can unmount the room',async()=>{
        render();await flush();const previous=render(),held=defer<ProjectChatDetail>();vi.mocked(projectChatApi.read).mockReturnValueOnce(held.promise);const refreshing=previous.refresh();
        vi.mocked(projectChatApi.send).mockRejectedValueOnce({isAxiosError:true,response:{status:403}});await expect(previous.send({requestKey:'key',prompt:'Question'})).rejects.toBeDefined();
        held.resolve(detail());await refreshing;expect(render().detail).toBeUndefined();expect(render().accessDenied).toBe(true);
    });
    it('a fresh denial also invalidates a held configuration ACK containing the private snapshot',async()=>{
        render();await flush();const previous=render(),held=defer<ProjectChatDetail>();vi.mocked(projectChatApi.participants).mockReturnValueOnce(held.promise);const configuring=previous.configure([]);
        vi.mocked(projectChatApi.send).mockRejectedValueOnce({isAxiosError:true,response:{status:403}});await expect(previous.send({requestKey:'key',prompt:'Question'})).rejects.toBeDefined();
        held.resolve(detail());expect(await configuring).toBe(false);expect(render().detail).toBeUndefined();expect(render().accessDenied).toBe(true);
    });
    it('an ACK for another room cannot clear the sender draft as if it were confirmed',async()=>{
        render();await flush();vi.mocked(projectChatApi.send).mockResolvedValueOnce({message:projectMessage({roomId:other}),roomRevision:2});await expect(render().send({requestKey:'key',prompt:'Question'})).rejects.toThrow('другому диалогу');
    });
    it('a private denial discards its title and invalidates a late previously-authorized list response',async()=>{
        renderRooms();await flush();renderRooms().select(id);renderRooms();const held=defer<ProjectChatRooms>();vi.mocked(projectChatApi.rooms).mockReturnValueOnce(held.promise);const refreshing=renderRooms().refresh();vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[list.rooms[0]]});renderRooms().forget(id);
        held.resolve(list);await refreshing;await flush();expect(renderRooms().roomId).toBe(DEFAULT_PROJECT_CHAT_ROOM);expect(renderRooms().data?.rooms.some(room=>room.id===id)).toBe(false);
    });
    it('a room denial invalidates a committed update whose ACK is still held and rejects it as an unconfirmed UI action',async()=>{
        renderRooms();await flush();renderRooms().select(id);const held=defer<ProjectChatRooms['rooms'][number]>();vi.mocked(projectChatApi.updateRoom).mockReturnValueOnce(held.promise);const saving=renderRooms().update(id,{expectedRevision:2,title:'New private title',memberEmails:[]});
        vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[list.rooms[0]]});renderRooms().forget(id);await flush();held.resolve({...list.rooms[1],title:'New private title',revision:3});
        await expect(saving).rejects.toThrow('Доступ к диалогам изменился');expect(renderRooms().roomId).toBe(DEFAULT_PROJECT_CHAT_ROOM);expect(JSON.stringify(renderRooms().data)).not.toContain('New private title');
    });
    it('ordinary room selection does not invalidate an accepted creation ACK',async()=>{
        renderRooms();await flush();const held=defer<ProjectChatRooms['rooms'][number]>();vi.mocked(projectChatApi.createRoom).mockReturnValueOnce(held.promise);const created={...list.rooms[1],id:other,title:'New private room'};
        const saving=renderRooms().create({requestKey:'key',title:created.title,visibility:'PRIVATE',memberEmails:[]});renderRooms().select(id);vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[...list.rooms,created]});held.resolve(created);
        expect(await saving).toEqual(created);await flush();expect(renderRooms().roomId).toBe(other);
    });
    it('comparison reads the exact current authorized summary and rejects its held snapshot after a fresh room denial',async()=>{
        renderRooms();await flush();vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[list.rooms[0],{...list.rooms[1],revision:8,title:'Fresh authorized title'}]});expect(await renderRooms().compare(id)).toMatchObject({id,revision:8,title:'Fresh authorized title'});
        const held=defer<ProjectChatRooms>();vi.mocked(projectChatApi.rooms).mockReturnValueOnce(held.promise);const comparing=renderRooms().compare(id);vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[list.rooms[0]]});renderRooms().forget(id);await flush();held.resolve(list);
        await expect(comparing).rejects.toThrow('Доступ изменился');expect(JSON.stringify(renderRooms().data)).not.toContain('SECRET TITLE');
    });
    it('removal from the authorized server list switches to the public default without preserving private selection',async()=>{
        renderRooms();await flush();renderRooms().select(id);renderRooms();vi.mocked(projectChatApi.rooms).mockResolvedValueOnce({...list,rooms:[list.rooms[0]]});await renderRooms().refresh();expect(renderRooms().roomId).toBe(DEFAULT_PROJECT_CHAT_ROOM);expect(JSON.stringify(renderRooms().data)).not.toContain('SECRET TITLE');
    });
});
