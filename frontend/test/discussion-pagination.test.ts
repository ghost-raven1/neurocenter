import {harness, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useDiscussion} from '../src/features/Discussions/useDiscussion';
import {discussionsApi} from '../src/features/Discussions/api';
import type {DiscussionComment, DiscussionPage} from '../src/features/Discussions/types';
vi.mock('../src/features/Discussions/api', () => ({discussionsApi: {list: vi.fn()}}));
const target = {type: 'help' as const, id: 'getting-started'};
const a = {id: 'a', version: 1, body: 'Первый', createdAt: '2026-10-23T00:00:00Z', deleted: false} as DiscussionComment;
const page = (items: DiscussionComment[], nextCursor: string | null = null): DiscussionPage => ({items, nextCursor, canComment: true, canAttach: false});
function render() {harness.begin(); const value = useDiscussion(target); harness.commit(); return value;}
async function settle() {for (let index = 0; index < 20; index++) await Promise.resolve(); return render();}
beforeEach(() => {vi.resetAllMocks(); ui.owns = true;});
afterEach(() => harness.dispose());
describe('Discussion pagination and authoritative denial', () => {
    it('Preserves prior pages and a newer edit receipt while loading the next page', async () => {
        vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a], 'next-a')).mockResolvedValueOnce(page([{...a, id: 'b', createdAt: '2026-10-23T00:00:01Z'}]));
        render(); let value = await settle(); value.saved({...a, body: 'Новая версия', version: 3}); value = render(); await value.load(value.page!.nextCursor!); value = await settle();
        expect(discussionsApi.list).toHaveBeenLastCalledWith(target, 'next-a'); expect(value.page?.items.map(value => value.id)).toEqual(['a', 'b']); expect(value.page?.items[0].body).toBe('Новая версия'); expect(value.page?.nextCursor).toBeNull();
    });
    it('A late older read cannot replace a newer mutation receipt', async () => {
        let resolve!: (value: DiscussionPage) => void; vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a])).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        render(); let value = await settle(); void value.load(); value.saved({...a, version: 3, body: 'Свежая версия'}); resolve(page([{...a, version: 2, body: 'Запоздалый снимок'}])); value = await settle();
        expect(value.page?.items[0].body).toBe('Свежая версия');
    });
    it('An authoritative first-page refresh drops previously loaded rows outside that snapshot', async () => {
        const second = {...a, id: 'b', body: 'Старая вторая страница', createdAt: '2026-10-23T00:00:01Z'};
        vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a], 'next-a')).mockResolvedValueOnce(page([second]))
            .mockResolvedValueOnce(page([{...a, version: 2, body: 'Актуальная первая страница'}], 'next-a'));
        render(); let value = await settle(); await value.load(value.page!.nextCursor!); value = await settle(); expect(value.page?.items.map(value => value.id)).toEqual(['a', 'b']);
        await value.load(); value = await settle(); expect(value.page?.items.map(value => value.id)).toEqual(['a']); expect(value.page?.items[0].body).toBe('Актуальная первая страница'); expect(value.page?.nextCursor).toBe('next-a');
    });
    it('An edit receipt invalidates a pending first-page read that omitted its row and releases loading', async () => {
        let resolve!: (value: DiscussionPage) => void;
        vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a])).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        render(); let value = await settle(); void value.load(); value = render(); expect(value.loading).toBe(true);
        value.saved({...a, id: 'ack-row', version: 3, body: 'Подтверждённая правка', createdAt: '2026-10-23T00:00:02Z'}); value = render(); expect(value.loading).toBe(false);
        resolve(page([a])); value = await settle(); expect(value.page?.items.map(value => value.id)).toEqual(['a', 'ack-row']); expect(value.page?.items[1].body).toBe('Подтверждённая правка');
    });
    it('An accepted deletion invalidates the pending read and keeps its tombstone', async () => {
        let resolve!: (value: DiscussionPage) => void;
        vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a])).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        render(); let value = await settle(); void value.load(); value.removed('a'); value = render(); expect(value.loading).toBe(false);
        resolve(page([{...a, version: 1, body: 'До удаления'}])); value = await settle(); expect(value.page?.items[0].deleted).toBe(true); expect(value.page?.items[0].body).toBe('');
    });
    it('GET403 removes private history and an old action receipt cannot bring it back', async () => {
        vi.mocked(discussionsApi.list).mockResolvedValueOnce(page([a])).mockRejectedValueOnce({isAxiosError: true, response: {status: 403}});
        render(); let value = await settle(); const oldSaved = value.saved; await value.load(); value = await settle(); expect(value.page).toBeUndefined(); oldSaved({...a, version: 2, body: 'Недоступный текст'}); value = render(); expect(value.page).toBeUndefined();
    });
});
