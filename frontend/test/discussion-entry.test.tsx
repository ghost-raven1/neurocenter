import {harness, renderUi, settleUi, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CommentEntry} from '../src/features/Discussions/CommentEntry';
import {discussionsApi} from '../src/features/Discussions/api';
import type {DiscussionComment} from '../src/features/Discussions/types';
vi.mock('../src/features/Discussions/api', () => ({discussionsApi: {get: vi.fn(), edit: vi.fn(), remove: vi.fn()}}));
const comment: DiscussionComment = {id: 'comment-a', parentId: null, body: 'Исходник', author: {email: 'a@example.test', displayName: 'Автор'}, version: 1, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', deleted: false, attachments: [], canEdit: true, canDelete: true};
let props: Parameters<typeof CommentEntry>[0];
const element = () => CommentEntry(props);
beforeEach(() => {vi.resetAllMocks(); ui.flags.clear(); ui.owns = true; props = {comment, canReply: true, onReply: vi.fn(), onSaved: vi.fn(), onRemoved: vi.fn()}; vi.mocked(discussionsApi.edit).mockResolvedValue({...comment, version: 2});});
afterEach(() => harness.dispose());
describe('Comment reply and editing controls', () => {
    it('A conflict retains draft and needs explicit latest-version review before PATCH retry', async () => {
        vi.mocked(discussionsApi.edit).mockRejectedValueOnce({isAxiosError: true, response: {status: 409}});
        vi.mocked(discussionsApi.get).mockResolvedValueOnce({...comment, body: 'Другой автор изменил', version: 4});
        renderUi(element); ui.buttons.get('Изменить')!(); renderUi(element); ui.inputs.get('Изменённый комментарий')!.onChange({target: {value: 'Моё уточнение'}}); renderUi(element); ui.buttons.get('Сохранить')!(); let view = await settleUi(element);
        expect(view.html).toContain('Моё уточнение'); expect(ui.buttons.has('Сохранить')).toBe(false); ui.buttons.get('Проверить комментарий')!(); await settleUi(element);
        expect(discussionsApi.edit).toHaveBeenCalledTimes(1); ui.buttons.get('Продолжить с этой версией, сохранив мой текст')!(); renderUi(element); ui.buttons.get('Сохранить')!(); await settleUi(element);
        expect(vi.mocked(discussionsApi.edit).mock.calls[1]).toEqual(['comment-a', 'Моё уточнение', 4]);
    });
    it('Closing the editor retains its text when reopened', () => {
        renderUi(element); ui.buttons.get('Изменить')!(); renderUi(element); ui.inputs.get('Изменённый комментарий')!.onChange({target: {value: 'Незавершённый текст'}}); renderUi(element); ui.buttons.get('Закрыть редактор')!(); renderUi(element); ui.buttons.get('Изменить')!(); renderUi(element);
        expect(ui.inputs.get('Изменённый комментарий')!.value).toBe('Незавершённый текст');
    });
    it('Flags OFF preserve the comment and own deletion while preventing new replies and edits', async () => {
        ui.flags.set('discussions', false); const view = renderUi(element); expect(view.html).toContain('Исходник'); expect(ui.buttons.has('Ответить')).toBe(false); expect(ui.buttons.has('Изменить')).toBe(false); expect(ui.buttons.has('Удалить')).toBe(false);
        expect(ui.confirmations).toHaveLength(1); ui.confirmations[0](); await settleUi(element); expect(discussionsApi.remove).toHaveBeenCalledWith('comment-a', 1);
    });
    it('A lost delete ACK can be reconciled by reading a tombstone without another DELETE', async () => {
        vi.mocked(discussionsApi.remove).mockRejectedValueOnce(new Error('lost ACK')); vi.mocked(discussionsApi.get).mockResolvedValueOnce({...comment, body: '', deleted: true, version: 2});
        renderUi(element); ui.confirmations[0](); await settleUi(element); ui.buttons.get('Проверить комментарий')!(); await settleUi(element);
        expect(discussionsApi.remove).toHaveBeenCalledTimes(1); expect(props.onSaved).toHaveBeenCalledWith(expect.objectContaining({deleted: true})); expect(ui.buttons.has('Проверить комментарий')).toBe(false);
    });
});
