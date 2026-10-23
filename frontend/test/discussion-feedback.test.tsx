import {createElement} from 'react';
import {harness, renderUi, settleUi, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CatalogFeedback} from '../src/features/Discussions/CatalogFeedback';
import {discussionsApi} from '../src/features/Discussions/api';
vi.mock('../src/features/Discussions/api', () => ({discussionsApi: {reaction: vi.fn(), setReaction: vi.fn()}}));
const element = () => createElement(CatalogFeedback, {catalogId: 'skill:common/test-skill', title: 'Тестовый скилл'});
beforeEach(() => {vi.resetAllMocks(); ui.flags.clear(); ui.owns = true; vi.mocked(discussionsApi.reaction).mockResolvedValue({liked: false, count: 2});});
afterEach(() => harness.dispose());
describe('Catalog heart acknowledgement', () => {
    it('Keeps the visible count after a lost ACK and retries the same desired like even with flag OFF', async () => {
        vi.mocked(discussionsApi.setReaction).mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValueOnce({liked: true, count: 3});
        renderUi(element); await settleUi(element); ui.buttons.get('Мне нравится')!(); let view = await settleUi(element);
        expect(view.html).toContain('aria-pressed="false"'); expect(view.html).toContain('>2</button>');
        ui.flags.set('catalog_reactions', false); renderUi(element); ui.buttons.get('Повторить')!(); view = await settleUi(element);
        expect(vi.mocked(discussionsApi.setReaction).mock.calls).toEqual([['skill:common/test-skill', true], ['skill:common/test-skill', true]]);
        expect(view.html).toContain('aria-pressed="true"'); expect(view.html).toContain('>3</button>');
    });
    it('Flag OFF retains comments and allows an existing heart to be removed', async () => {
        vi.mocked(discussionsApi.reaction).mockResolvedValueOnce({liked: true, count: 3}); vi.mocked(discussionsApi.setReaction).mockResolvedValueOnce({liked: false, count: 2}); ui.flags.set('catalog_reactions', false);
        renderUi(element); await settleUi(element); expect(ui.buttons.has('Комментарии')).toBe(true); ui.buttons.get('Убрать из понравившихся')!(); await settleUi(element);
        expect(discussionsApi.setReaction).toHaveBeenCalledWith('skill:common/test-skill', false); expect(ui.buttons.has('Мне нравится')).toBe(false);
    });
    it('Does not display a late like receipt belonging to the old owner', async () => {
        let resolve!: (value: {liked: boolean; count: number}) => void; vi.mocked(discussionsApi.setReaction).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        renderUi(element); await settleUi(element); ui.buttons.get('Мне нравится')!(); ui.owns = false; resolve({liked: true, count: 3}); const view = await settleUi(element);
        expect(view.html).not.toContain('aria-pressed="true"'); expect(view.html).toContain('>2</button>');
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
