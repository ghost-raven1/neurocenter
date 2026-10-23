import {harness, nativeInput, renderUi, settleUi, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CommentComposer} from '../src/features/Discussions/CommentComposer';
import {discussionsApi} from '../src/features/Discussions/api';
import type {DiscussionComment} from '../src/features/Discussions/types';
vi.mock('../src/features/Discussions/api', () => ({discussionsApi: {create: vi.fn(), upload: vi.fn(), removeUpload: vi.fn()}}));
const comment: DiscussionComment = {id: 'comment-a', parentId: null, body: 'Сохранено', author: {email: 'a@example.test', displayName: 'Автор'}, version: 1, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z', deleted: false, attachments: [], canEdit: true, canDelete: true};
let key = 0;
const target = {type: 'catalog' as const, id: 'mcp:tool-a'};
const onSaved = vi.fn(), onCancelReply = vi.fn();
let props: Parameters<typeof CommentComposer>[0];
const element = () => CommentComposer(props);
beforeEach(() => {vi.resetAllMocks(); ui.flags.clear(); ui.owns = true; props = {target, draftKey: 'composer-' + (++key), canComment: true, canAttach: true, onSaved, onCancelReply}; vi.mocked(discussionsApi.create).mockResolvedValue(comment);});
afterEach(() => harness.dispose());
describe('Discussion composer: retained intents and attachments', () => {
    it('Retries a lost comment ACK with the exact key, text and reply even after flags OFF', async () => {
        props.reply = {...comment, id: 'parent-a'};
        vi.mocked(discussionsApi.create).mockRejectedValueOnce(new Error('ACK lost'));
        renderUi(element); ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Мой ответ'}}); renderUi(element);
        ui.buttons.get('Отправить')!(); let view = await settleUi(element);
        expect(view.html).toContain('Мой ответ'); expect(ui.inputs.get('Текст комментария')!.disabled).toBe(true);
        const first = vi.mocked(discussionsApi.create).mock.calls[0][1]; expect(first.parentId).toBe('parent-a');
        ui.flags.set('discussions', false); props.canComment = false; renderUi(element);
        expect(ui.buttons.has('Повторить отправку')).toBe(true); ui.buttons.get('Повторить отправку')!(); view = await settleUi(element);
        expect(discussionsApi.create).toHaveBeenCalledTimes(2); expect(vi.mocked(discussionsApi.create).mock.calls[1][1]).toEqual(first);
        expect(first.body).toBe('Мой ответ'); expect(onSaved).toHaveBeenCalledTimes(1); expect(view.html).not.toContain('Мой ответ');
    });
    it('Retains a failed file and retries its original bytes/key before creating the comment', async () => {
        const file = new File(['fixture'], 'лог.txt', {type: 'text/plain'}), uploaded = {id: 'file-a', name: file.name, mediaType: 'text/plain', bytes: file.size, url: '/api/discussions/attachments/file-a/content'};
        vi.mocked(discussionsApi.upload).mockRejectedValueOnce(new Error('upload ACK lost')).mockResolvedValueOnce(uploaded);
        let view = renderUi(element); nativeInput(view.element).onChange({target: {files: [file], value: 'local'}}); renderUi(element);
        ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Текст с файлом'}}); renderUi(element); ui.buttons.get('Отправить')!(); view = await settleUi(element);
        expect(view.html).toContain('лог.txt'); expect(view.html).toContain('Текст с файлом'); expect(discussionsApi.create).not.toHaveBeenCalled();
        const first = vi.mocked(discussionsApi.upload).mock.calls[0]; ui.buttons.get('Отправить')!(); await settleUi(element);
        const retry = vi.mocked(discussionsApi.upload).mock.calls[1]; expect(retry[1]).toBe(file); expect(retry[2]).toBe(first[2]);
        expect(discussionsApi.create).toHaveBeenCalledWith(target, expect.objectContaining({body: 'Текст с файлом', attachmentIds: ['file-a']}));
    });
    it('Can remove an unavailable file and send text without S3', async () => {
        const file = new File(['fixture'], 'trace.txt'); let view = renderUi(element); nativeInput(view.element).onChange({target: {files: [file], value: 'local'}}); renderUi(element);
        ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Можно без вложения'}}); props.canAttach = false; props.attachmentsUnavailableReason = 'Хранилище недоступно'; renderUi(element);
        ui.buttons.get('Отправить')!(); view = await settleUi(element); expect(discussionsApi.create).not.toHaveBeenCalled(); expect(view.html).toContain('Уберите вложения');
        ui.buttons.get('Убрать файл trace.txt')!(); await settleUi(element); ui.buttons.get('Отправить')!(); await settleUi(element);
        expect(discussionsApi.upload).not.toHaveBeenCalled(); expect(discussionsApi.create).toHaveBeenCalledWith(target, expect.objectContaining({body: 'Можно без вложения', attachmentIds: []}));
    });
    it('Rejects oversized UTF-8 text before an HTTP mutation', async () => {
        renderUi(element); ui.inputs.get('Текст комментария')!.onChange({target: {value: '界'.repeat(6000)}}); renderUi(element); ui.buttons.get('Отправить')!(); const view = await settleUi(element);
        expect(discussionsApi.create).not.toHaveBeenCalled(); expect(view.html).toContain('16 000 байт');
    });
    it('Requires text before uploading a file, matching the server live-comment contract', async () => {
        const view = renderUi(element); nativeInput(view.element).onChange({target: {files: [new File(['fixture'], 'only-file.txt')], value: 'local'}}); renderUi(element); ui.buttons.get('Отправить')!(); const result = await settleUi(element);
        expect(result.html).toContain('Напишите комментарий: к нему можно прикрепить файлы.'); expect(discussionsApi.upload).not.toHaveBeenCalled(); expect(discussionsApi.create).not.toHaveBeenCalled();
    });
    it('Already uploaded files remain removable when attachment flags turn OFF before a new comment', async () => {
        const file = new File(['fixture'], 'ready.txt');
        vi.mocked(discussionsApi.upload).mockResolvedValueOnce({id: 'ready-file', name: file.name, mediaType: 'text/plain', bytes: file.size, url: '/api/discussions/attachments/ready-file/content'});
        vi.mocked(discussionsApi.create).mockRejectedValueOnce({isAxiosError: true, response: {status: 400}}); vi.mocked(discussionsApi.removeUpload).mockResolvedValueOnce({ok: true});
        const view = renderUi(element); nativeInput(view.element).onChange({target: {files: [file], value: 'local'}}); renderUi(element); ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Текст с готовым файлом'}}); renderUi(element); ui.buttons.get('Отправить')!(); await settleUi(element);
        ui.flags.set('discussion_attachments', false); props.canAttach = false; renderUi(element); ui.buttons.get('Отправить')!(); await settleUi(element); expect(discussionsApi.create).toHaveBeenCalledTimes(1);
        ui.buttons.get('Убрать файл ready.txt')!(); await settleUi(element); expect(discussionsApi.removeUpload).toHaveBeenCalledWith('ready-file'); ui.buttons.get('Отправить')!(); await settleUi(element); expect(discussionsApi.create).toHaveBeenCalledTimes(2); expect(vi.mocked(discussionsApi.create).mock.calls[1][1].attachmentIds).toEqual([]);
    });
    it('A late receipt cannot clear another actor context or call its saved handler', async () => {
        let resolve!: (value: DiscussionComment) => void; vi.mocked(discussionsApi.create).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        renderUi(element); ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Приватный текст'}}); renderUi(element); ui.buttons.get('Отправить')!();
        ui.owns = false; resolve(comment); await settleUi(element); expect(onSaved).not.toHaveBeenCalled(); expect(onCancelReply).not.toHaveBeenCalled();
    });
    it('Closing and reopening a drawer restores only its actor/target draft', () => {
        renderUi(element); ui.inputs.get('Текст комментария')!.onChange({target: {value: 'Черновик карточки A'}}); renderUi(element); const original = props.draftKey;
        harness.dispose(); props = {...props, draftKey: 'actor-b:tool-b'}; renderUi(element); expect(ui.inputs.get('Текст комментария')!.value).toBe('');
        harness.dispose(); props = {...props, draftKey: original}; renderUi(element); expect(ui.inputs.get('Текст комментария')!.value).toBe('Черновик карточки A');
    });
});
