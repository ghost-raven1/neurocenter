import {harness, nativeInput, renderUi, settleUi, ui} from './discussions-ui-fixture';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HelpEditor} from '../src/modules/Help/HelpEditor';
import {helpApi} from '../src/modules/Help/api';
import type {HelpArticle} from '../src/modules/Help/types';
vi.mock('../src/modules/Help/api', () => ({helpApi: {get: vi.fn(), save: vi.fn()}}));
const article: HelpArticle = {slug: 'bridge', title: 'Мост', summary: '', content: '# Мост\n\nСтарый текст', revision: 'sha-old', updatedAt: '2026-10-23', canEdit: true};
const onSaved = vi.fn(), onClose = vi.fn();
let props: Parameters<typeof HelpEditor>[0];
const element = () => HelpEditor(props);
beforeEach(() => {vi.resetAllMocks(); ui.flags.clear(); ui.owns = true; props = {article, open: true, onSaved, onClose}; vi.mocked(helpApi.save).mockResolvedValue(article);});
afterEach(() => harness.dispose());
describe('Help Markdown editor: retained source and disk revision', () => {
    it('Keeps local Markdown after conflict, reviews actual disk content and explicitly rebases its SHA', async () => {
        vi.mocked(helpApi.save).mockRejectedValueOnce({isAxiosError: true, response: {status: 409}}).mockResolvedValueOnce({...article, content: '# Моя версия', revision: 'sha-saved'});
        vi.mocked(helpApi.get).mockResolvedValueOnce({...article, content: '# Изменено на диске', revision: 'sha-disk'});
        renderUi(element); ui.inputs.get('Markdown статьи')!.onChange({target: {value: '# Моя версия'}}); renderUi(element); ui.buttons.get('Сохранить статью')!(); let view = await settleUi(element);
        expect(view.html).toContain('# Моя версия'); expect(ui.buttons.has('Сохранить статью')).toBe(false);
        ui.buttons.get('Прочитать актуальную статью')!(); view = await settleUi(element); expect(view.html).toContain('# Изменено на диске'); expect(helpApi.save).toHaveBeenCalledTimes(1);
        ui.buttons.get('Использовать эту версию, сохранив мой текст')!(); renderUi(element); ui.buttons.get('Сохранить статью')!(); await settleUi(element);
        expect(vi.mocked(helpApi.save).mock.calls[1]).toEqual(['bridge', '# Моя версия', 'sha-disk']); expect(onSaved).toHaveBeenCalledTimes(1);
    });
    it('A lost save ACK is confirmed by the exact Markdown from GET without sending a second PUT', async () => {
        vi.mocked(helpApi.save).mockRejectedValueOnce(new Error('ACK lost')); vi.mocked(helpApi.get).mockResolvedValueOnce({...article, content: '# Сохранено', revision: 'sha-new'});
        renderUi(element); ui.inputs.get('Markdown статьи')!.onChange({target: {value: '# Сохранено'}}); renderUi(element); ui.buttons.get('Сохранить статью')!(); await settleUi(element);
        ui.buttons.get('Прочитать актуальную статью')!(); await settleUi(element); expect(helpApi.save).toHaveBeenCalledTimes(1); expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({content: '# Сохранено', revision: 'sha-new'}));
    });
    it('A failed creation before file publication has an explicit retry after GET confirms absence', async () => {
        props.article = undefined; vi.mocked(helpApi.save).mockRejectedValueOnce(new Error('Offline')); vi.mocked(helpApi.get).mockRejectedValueOnce({isAxiosError: true, response: {status: 404}});
        renderUi(element); ui.inputs.get('help-article-slug')!.onChange({target: {value: 'new-help'}}); ui.inputs.get('Markdown статьи')!.onChange({target: {value: '# Новый ответ'}}); renderUi(element); ui.buttons.get('Сохранить статью')!(); await settleUi(element);
        ui.buttons.get('Прочитать актуальную статью')!(); await settleUi(element); ui.buttons.get('Вернуться к созданию, сохранив мой текст')!(); renderUi(element); ui.buttons.get('Сохранить статью')!(); await settleUi(element);
        expect(vi.mocked(helpApi.save).mock.calls[1]).toEqual(['new-help', '# Новый ответ', null]);
    });
    it('Imports a UTF-8 .md file and derives the new article slug without uploading unrelated files', async () => {
        props.article = undefined; let view = renderUi(element); nativeInput(view.element).onChange({target: {files: [new File(['# Из архива\n\nТекст'], 'archive.md')], value: 'local'}}); view = await settleUi(element);
        expect(ui.inputs.get('help-article-slug')!.value).toBe('archive'); expect(ui.inputs.get('Markdown статьи')!.value).toBe('# Из архива\n\nТекст'); expect(helpApi.save).not.toHaveBeenCalled();
        nativeInput(view.element).onChange({target: {files: [new File(['<html>'], 'not-markdown.html')], value: 'local'}}); await settleUi(element); expect(ui.inputs.get('Markdown статьи')!.value).toBe('# Из архива\n\nТекст');
    });
    it('Flag OFF preserves the editable source and export while blocking article publication', () => {
        ui.flags.set('help_center', false); renderUi(element); ui.inputs.get('Markdown статьи')!.onChange({target: {value: '# Черновик'}}); renderUi(element);
        expect(ui.inputs.get('Markdown статьи')!.value).toBe('# Черновик'); expect(ui.buttons.has('Скачать .md')).toBe(true); expect(ui.buttons.has('Сохранить статью')).toBe(false); expect(helpApi.save).not.toHaveBeenCalled();
    });
    it('A late save receipt from a former actor cannot close the current editor', async () => {
        let resolve!: (value: HelpArticle) => void; vi.mocked(helpApi.save).mockImplementationOnce(() => new Promise(done => {resolve = done;}));
        renderUi(element); ui.buttons.get('Сохранить статью')!(); ui.owns = false; resolve(article); await settleUi(element); expect(onSaved).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    });
});
