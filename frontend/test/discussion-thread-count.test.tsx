import {createElement} from 'react';
import {harness,renderUi,ui} from './discussions-ui-fixture';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DiscussionThread} from '../src/features/Discussions/DiscussionThread';
import type {DiscussionComment,DiscussionPage} from '../src/features/Discussions/types';
const fixture=vi.hoisted(()=>({page:undefined as (DiscussionPage&{totalCount?:number})|undefined,load:vi.fn(),saved:vi.fn(),removed:vi.fn(),changed:vi.fn(),
    create:undefined as ((value:DiscussionComment)=>void)|undefined,remove:undefined as (()=>void)|undefined}));
vi.mock('../src/features/Discussions/useDiscussion',()=>({useDiscussion:()=>({...fixture,loading:false,error:''})}));
vi.mock('../src/features/Discussions/CommentComposer',()=>({CommentComposer:({onSaved}:{onSaved:(value:DiscussionComment)=>void})=>{fixture.create=onSaved;return null;}}));
vi.mock('../src/features/Discussions/CommentEntry',()=>({CommentEntry:({onRemoved}:{onRemoved:()=>void})=>{fixture.remove=onRemoved;return null;}}));
const comment={id:'one',version:1,body:'Комментарий',createdAt:'2026-10-23',deleted:false} as DiscussionComment;
const element=()=>createElement(DiscussionThread,{target:{type:'help',id:'opencode-lsp'},...{onChanged:fixture.changed}});
beforeEach(()=>{vi.clearAllMocks();ui.owns=true;fixture.page={items:[comment],nextCursor:'later',canComment:true,canAttach:false,totalCount:72};fixture.create=undefined;fixture.remove=undefined;});
afterEach(()=>harness.dispose());
describe('Общий счетчик обсуждения для Помощи и каталога',()=>{
    it('Заголовок показывает серверный totalCount, а не число загруженных строк страницы',()=>{
        expect(renderUi(element).html).toContain('Обсуждение · 72');
    });
    it.each([0,undefined])('Нулевой или неизвестный totalCount=%s не подменяется числом строк',totalCount=>{
        fixture.page={...fixture.page!,totalCount};const html=renderUi(element).html;expect(html).toContain('Обсуждение');expect(html).not.toContain('Обсуждение ·');
    });
    it('Создание и удаление обновляют точный счетчик, сохраняют загруженные страницы и уведомляют карточку',()=>{
        renderUi(element);fixture.create!({...comment,id:'accepted'});expect(fixture.saved).toHaveBeenCalledWith(expect.objectContaining({id:'accepted'}));
        expect(fixture.load).toHaveBeenLastCalledWith(undefined,true);expect(fixture.changed).toHaveBeenCalledOnce();
        fixture.remove!();expect(fixture.removed).toHaveBeenCalledWith(comment.id);expect(fixture.load).toHaveBeenLastCalledWith(undefined,true);expect(fixture.changed).toHaveBeenCalledTimes(2);
    });
});
