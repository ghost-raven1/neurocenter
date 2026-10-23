import {createElement} from 'react';
import {harness, renderUi, settleUi, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CatalogFeedback} from '../src/features/Discussions/CatalogFeedback';
import {discussionsApi} from '../src/features/Discussions/api';
const thread=vi.hoisted(()=>({changed:undefined as (()=>void)|undefined}));
vi.mock('../src/features/Discussions/api', () => ({discussionsApi: {reaction: vi.fn(), setReaction: vi.fn()}}));
vi.mock('../src/features/Discussions/DiscussionThread',()=>({DiscussionThread:({onChanged}:{onChanged?:()=>void})=>{thread.changed=onChanged;return null;}}));
const element = () => createElement(CatalogFeedback, {catalogId: 'skill:common/test-skill', title: 'Тестовый скилл'});
beforeEach(() => {vi.resetAllMocks(); ui.flags.clear(); ui.owns = true;thread.changed=undefined; vi.mocked(discussionsApi.reaction).mockResolvedValue({liked: false, count: 2});});
afterEach(() => harness.dispose());
describe('Catalog heart acknowledgement', () => {
    it('Нулевые сердечки и комментарии не показывают цифру 0',async()=>{
        vi.mocked(discussionsApi.reaction).mockResolvedValue(Object.assign({liked:false,count:0},{commentCount:0}));renderUi(element);const view=await settleUi(element);
        expect(view.html).not.toMatch(/aria-label="Мне нравится"[^>]*>0<\/button>/);expect(view.html).not.toContain('catalog-feedback__count');expect(ui.buttons.has('Комментарии')).toBe(true);
    });
    it('Ненулевые отметки и точный серверный счетчик комментариев имеют отдельный от иконки текст',async()=>{
        vi.mocked(discussionsApi.reaction).mockResolvedValue(Object.assign({liked:false,count:2},{commentCount:71}));renderUi(element);const view=await settleUi(element);
        expect(view.html).toContain('<span class="catalog-feedback__count">2</span>');expect(view.html).toContain('<span class="catalog-feedback__count">71</span>');expect(ui.buttons.has('Комментарии: 71')).toBe(true);
    });
    it('Счетчик обновляется после подтвержденной мутации обсуждения и закрытия панели без загрузки всех тредов',async()=>{
        vi.mocked(discussionsApi.reaction).mockResolvedValueOnce(Object.assign({liked:false,count:0},{commentCount:1})).mockResolvedValueOnce(Object.assign({liked:false,count:0},{commentCount:2})).mockResolvedValueOnce(Object.assign({liked:false,count:0},{commentCount:0}));
        renderUi(element);await settleUi(element);ui.buttons.get('Комментарии: 1')!();renderUi(element);expect(thread.changed).toBeDefined();
        thread.changed!();await settleUi(element);expect(ui.buttons.has('Комментарии: 2')).toBe(true);ui.drawerClose!();await settleUi(element);expect(ui.buttons.has('Комментарии')).toBe(true);expect(discussionsApi.reaction).toHaveBeenCalledTimes(3);
    });
    it('Не выдаёт отсутствие нового поля старого сервера за нулевой счетчик комментариев',async()=>{
        renderUi(element);const view=await settleUi(element);expect(ui.buttons.has('Комментарии')).toBe(true);expect(view.html).not.toContain('Комментарии: 0');
    });
    it('Обновление комментариев не перетирает неподтвержденную отметку сердца',async()=>{
        let reject!:(cause:Error)=>void;vi.mocked(discussionsApi.setReaction).mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail;}));
        renderUi(element);await settleUi(element);ui.buttons.get('Комментарии')!();renderUi(element);ui.buttons.get('Мне нравится')!();
        thread.changed!();await settleUi(element);expect(discussionsApi.reaction).toHaveBeenCalledTimes(1);
        reject(new Error('lost ACK'));await settleUi(element);ui.drawerClose!();await settleUi(element);expect(discussionsApi.reaction).toHaveBeenCalledTimes(1);
        expect(vi.mocked(discussionsApi.setReaction).mock.calls).toEqual([['skill:common/test-skill',true]]);expect(ui.buttons.has('Повторить')).toBe(true);
    });
    it('Keeps the visible count after a lost ACK and retries the same desired like even with flag OFF', async () => {
        vi.mocked(discussionsApi.setReaction).mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValueOnce({liked: true, count: 3});
        renderUi(element); await settleUi(element); ui.buttons.get('Мне нравится')!(); let view = await settleUi(element);
        expect(view.html).toContain('aria-pressed="false"'); expect(view.html).toContain('catalog-feedback__count">2</span>');
        ui.flags.set('catalog_reactions', false); renderUi(element); ui.buttons.get('Повторить')!(); view = await settleUi(element);
        expect(vi.mocked(discussionsApi.setReaction).mock.calls).toEqual([['skill:common/test-skill', true], ['skill:common/test-skill', true]]);
        expect(view.html).toContain('aria-pressed="true"'); expect(view.html).toContain('catalog-feedback__count">3</span>');
    });
    it('Flag OFF retains comments and allows an existing heart to be removed', async () => {
        vi.mocked(discussionsApi.reaction).mockResolvedValueOnce({liked: true, count: 3}); vi.mocked(discussionsApi.setReaction).mockResolvedValueOnce({liked: false, count: 2}); ui.flags.set('catalog_reactions', false);
        renderUi(element); await settleUi(element); expect(ui.buttons.has('Комментарии')).toBe(true); ui.buttons.get('Убрать из понравившихся')!(); await settleUi(element);
        expect(discussionsApi.setReaction).toHaveBeenCalledWith('skill:common/test-skill', false); expect(ui.buttons.has('Мне нравится')).toBe(false);
    });
    it('Does not display a late like receipt belonging to the old owner', async () => {
        let resolve!: (value: {liked: boolean; count: number}) => void; vi.mocked(discussionsApi.setReaction).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        renderUi(element); await settleUi(element); ui.buttons.get('Мне нравится')!(); ui.owns = false; resolve({liked: true, count: 3}); const view = await settleUi(element);
        expect(view.html).not.toContain('aria-pressed="true"'); expect(view.html).toContain('catalog-feedback__count">2</span>');
    });
    it('A definite rejection ends an unknown intent and exposes GET review before another user choice', async () => {
        vi.mocked(discussionsApi.setReaction).mockRejectedValueOnce(new Error('lost ACK'))
            .mockRejectedValueOnce({isAxiosError: true, response: {status: 403, data: {message: 'Функция выключена'}}})
            .mockResolvedValueOnce({liked: false, count: 2});
        renderUi(element); await settleUi(element); ui.buttons.get('Мне нравится')!(); await settleUi(element);
        ui.flags.set('catalog_reactions', false); renderUi(element); ui.buttons.get('Повторить')!(); await settleUi(element);
        vi.mocked(discussionsApi.reaction).mockResolvedValueOnce({liked: true, count: 3}); ui.buttons.get('Повторить')!(); await settleUi(element);
        expect(discussionsApi.setReaction).toHaveBeenCalledTimes(2); expect(discussionsApi.reaction).toHaveBeenCalledTimes(2);
        ui.flags.set('catalog_reactions', true); renderUi(element); ui.buttons.get('Убрать из понравившихся')!(); await settleUi(element);
        expect(vi.mocked(discussionsApi.setReaction).mock.calls).toEqual([['skill:common/test-skill', true], ['skill:common/test-skill', true], ['skill:common/test-skill', false]]);
    });
});
