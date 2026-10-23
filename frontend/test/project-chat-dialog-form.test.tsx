import {harness,renderProjectUi,settleProjectUi,ui} from './project-chat-ui-fixture';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ProjectChatDialogForm} from '../src/features/ProjectChat/ProjectChatDialogForm';
import type {ProjectChatRoomSummary} from '../src/features/ProjectChat/types';
let count=0,props:Parameters<typeof ProjectChatDialogForm>[0];
const element=()=>ProjectChatDialogForm(props), create=vi.fn(),update=vi.fn(),compare=vi.fn(),close=vi.fn();
const room:ProjectChatRoomSummary={id:'115af965-9952-402f-8811-20ae55f47991',title:'Private review',visibility:'PRIVATE',revision:7,updatedAt:'2026-10-23T00:00:00Z',canManage:true,memberEmails:['alice@example.test','bob@example.test']};
beforeEach(()=>{vi.clearAllMocks();ui.flags.clear();ui.owner='alice';props={draftKey:'dialog-create-'+(++count),members:[{email:'bob@example.test',displayName:'Bob',role:'Разработчик'}],onCreate:create,onUpdate:update,onCompare:compare,onClose:close};create.mockResolvedValue(room);update.mockResolvedValue(room);compare.mockResolvedValue(room);});
afterEach(()=>harness.dispose());
const name=(value:string)=>{renderProjectUi(element);ui.inputs.get('Название диалога')!.onChange({target:{value}});renderProjectUi(element);};
describe('Named project dialogues explain and preserve their audience',()=>{
    it('public creation explicitly uses the whole project, without an accidental private subset',async()=>{
        name(' Release ');ui.buttons.get('Создать диалог')!();await settleProjectUi(element);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({title:'Release',visibility:'PUBLIC',memberEmails:[]}));expect(close).toHaveBeenCalledOnce();
    });
    it('private creation sends explicit people and explains that admins are not silently invited',async()=>{
        name('Private');ui.selects.get('Доступ к диалогу')!.onChange('PRIVATE');renderProjectUi(element);ui.selects.get('Люди в приватном диалоге')!.onChange(['bob@example.test']);const view=renderProjectUi(element);expect(view.html).toContain('Администратор не добавляется автоматически');ui.buttons.get('Создать диалог')!();await settleProjectUi(element);
        expect(create).toHaveBeenCalledWith(expect.objectContaining({visibility:'PRIVATE',memberEmails:['bob@example.test']}));
    });
    it('lost acknowledgement freezes the exact request and survives closing/reopening the form',async()=>{
        create.mockRejectedValueOnce(new Error('ACK lost'));name('Release retry');ui.buttons.get('Создать диалог')!();await settleProjectUi(element);const first=create.mock.calls[0][0];expect(ui.inputs.get('Название диалога')?.disabled).toBe(true);
        harness.dispose();renderProjectUi(element);ui.buttons.get('Проверить создание')!();await settleProjectUi(element);expect(create.mock.calls[1][0]).toEqual(first);
    });
    it('a stale membership save keeps its edited values and never silently adopts another revision',async()=>{
        props.room=room;update.mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Changed'}}});renderProjectUi(element);ui.selects.get('Люди в приватном диалоге')!.onChange(['alice@example.test']);renderProjectUi(element);ui.buttons.get('Сохранить диалог')!();await settleProjectUi(element);
        expect(update).toHaveBeenCalledWith(room.id,{expectedRevision:7,title:room.title,memberEmails:['alice@example.test']});expect(ui.selects.get('Люди в приватном диалоге')!.value).toEqual(['alice@example.test']);expect(close).not.toHaveBeenCalled();
    });
    it('an explicit authorized comparison after a CAS conflict preserves the draft and unlocks a save with the reviewed revision only',async()=>{
        props.room=room;update.mockRejectedValueOnce({isAxiosError:true,response:{status:409,data:{message:'Changed'}}});name('My edited title');ui.selects.get('Люди в приватном диалоге')!.onChange(['alice@example.test']);renderProjectUi(element);ui.buttons.get('Сохранить диалог')!();await settleProjectUi(element);
        expect(ui.buttons.has('Сохранить диалог')).toBe(false);expect(ui.buttons.has('Сравнить с текущими')).toBe(true);
        compare.mockRejectedValueOnce(new Error('Read failed'));ui.buttons.get('Сравнить с текущими')!();await settleProjectUi(element);expect(ui.inputs.get('Название диалога')!.value).toBe('My edited title');expect(ui.buttons.has('Сохранить диалог')).toBe(false);
        compare.mockResolvedValueOnce({...room,title:'Other saved title',revision:9,memberEmails:['alice@example.test','carol@example.test']});ui.buttons.get('Сравнить с текущими')!();const comparison=await settleProjectUi(element);
        expect(compare).toHaveBeenCalledWith(room.id);expect(comparison.html).toContain('Other saved title');expect(comparison.html).toContain('carol@example.test');expect(ui.inputs.get('Название диалога')!.value).toBe('My edited title');expect(ui.selects.get('Люди в приватном диалоге')!.value).toEqual(['alice@example.test']);
        props.room={...room,revision:11,title:'Unreviewed poll update'};renderProjectUi(element);ui.buttons.get('Сохранить диалог')!();await settleProjectUi(element);
        expect(update.mock.calls[1]).toEqual([room.id,{expectedRevision:9,title:'My edited title',memberEmails:['alice@example.test']}]);expect(close).toHaveBeenCalledOnce();
    });
    it('a denied comparison preserves an edit draft and its required review across close/reopen',async()=>{
        props.room=room;update.mockRejectedValueOnce({isAxiosError:true,response:{status:409}});name('Draft kept after denial');ui.selects.get('Люди в приватном диалоге')!.onChange(['alice@example.test']);renderProjectUi(element);ui.buttons.get('Сохранить диалог')!();await settleProjectUi(element);
        compare.mockRejectedValueOnce({isAxiosError:true,response:{status:404}});ui.buttons.get('Сравнить с текущими')!();await settleProjectUi(element);expect(close).not.toHaveBeenCalled();harness.dispose();renderProjectUi(element);
        expect(ui.inputs.get('Название диалога')!.value).toBe('Draft kept after denial');expect(ui.selects.get('Люди в приватном диалоге')!.value).toEqual(['alice@example.test']);expect(ui.buttons.has('Сохранить диалог')).toBe(false);expect(ui.buttons.has('Сравнить с текущими')).toBe(true);
    });
    it('a comparison completed after closing the form cannot adopt a new baseline into the saved draft',async()=>{
        props.room=room;update.mockRejectedValueOnce({isAxiosError:true,response:{status:409}});name('Keep old draft');ui.buttons.get('Сохранить диалог')!();await settleProjectUi(element);
        let release!:(value:ProjectChatRoomSummary)=>void;compare.mockReturnValueOnce(new Promise<ProjectChatRoomSummary>(resolve=>{release=resolve;}));ui.buttons.get('Сравнить с текущими')!();harness.dispose();release({...room,revision:99,title:'Late comparison'});await settleProjectUi(element);
        expect(ui.inputs.get('Название диалога')!.value).toBe('Keep old draft');expect(ui.buttons.has('Сохранить диалог')).toBe(false);expect(renderProjectUi(element).html).not.toContain('ревизия 99');
    });
    it('flags OFF still allow narrowing private access but disable a new invitation',async()=>{
        props.room=room;ui.flags.set('project_chat_dialogs',false);renderProjectUi(element);ui.selects.get('Люди в приватном диалоге')!.onChange(['alice@example.test']);renderProjectUi(element);expect(ui.buttons.has('Сохранить диалог')).toBe(true);
        ui.selects.get('Люди в приватном диалоге')!.onChange(['alice@example.test','new@example.test']);renderProjectUi(element);expect(ui.buttons.has('Сохранить диалог')).toBe(false);
    });
});
