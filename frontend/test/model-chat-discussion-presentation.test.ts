import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import {ChatMessages} from '../src/features/ModelChat/ChatMessages';
import type {IModelChatResponse, IModelChatTurn} from '../src/features/ModelChat/types';

// History stays readable even when the optional activity feature is disabled.
vi.mock('../src/features/FeatureFlags/FeatureAvailability', async () => {
    const {Button} = await import('antd');
    return {FeatureButton: Button, useFeatureAvailability: () => ({enabled: false})};
});

const response = (changes: Partial<IModelChatResponse> = {}): IModelChatResponse => ({
    id: 'response-one', agentId: 'developer', name: 'Разработчик', slug: 'developer', version: 1,
    status: 'done', modelId: 'model-one', modelName: 'Модель проекта', modelPin: 'model-pin',
    answer: {content: 'Сохранённый факт 7391', finishReason: 'stop'}, ...changes,
});
const turn = (changes: Partial<IModelChatTurn> = {}): IModelChatTurn => ({
    id: 'turn-one', requestId: 'request-one', prompt: 'Проверьте решение', attachmentIds: [], createdAt: '2026-10-24T15:00:00Z',
    status: 'done', responses: [response()], discussion: {mode: 'automatic', callsStarted: 3, maxCalls: 5}, ...changes,
});
const show = (value: IModelChatTurn): string => renderToStaticMarkup(createElement(ChatMessages, {
    turns: [value], attachments: [], modelName: 'Модель проекта', group: true, blocked: false, busy: false,
    onRetry: vi.fn(), onEdit: vi.fn(), onPreview: vi.fn(), onComplete: vi.fn(),
}));

describe('Сохранённая автоматическая дискуссия', () => {
    it.each(['failed', 'cancelled'] as const)('сохраняет ответы и объясняет продолжение после %s без кнопок повторного запуска', status => {
        const html = show(turn({status, error: 'Итог обсуждения не получен.'}));
        expect(html).toContain('Сохранённый факт 7391');
        expect(html).toContain('Итог обсуждения не получен.');
        expect(html).toContain('Продолжите новым сообщением');
        expect(html).not.toContain('Повторить неуспешные ответы');
        expect(html).not.toContain('Продолжить с готовыми ответами');
    });
    it('показывает единственный серверный итог вместе с ответами и предупреждением об обрезке', () => {
        const html = show(turn({responses: [response({answer: {content: 'Сохранённый факт 7391', finishReason: 'length'}}),
            response({id: 'turn-one', agentId: 'discussion-summary', name: 'Итог обсуждения', answer: {content: 'Общий итог 8412', finishReason: 'stop'}})]}));
        expect(html).toContain('Сохранённый факт 7391');
        expect(html.match(/Общий итог 8412/g)).toHaveLength(1);
        expect(html).toContain('Ответ достиг лимита токенов');
    });
    it.each([{responses: []}, {responses: [response()]}])('показывает продолжающуюся работу до итогового ответа', ({responses}) => {
        const html = show(turn({status: 'pending', responses}));
        expect(html).toContain('Агенты обсуждают задачу');
        expect(html).not.toContain('Повторить');
    });
    it('сохраняет привычные действия для прежнего независимого группового раунда', () => {
        const html = show(turn({status: 'failed', discussion: undefined}));
        expect(html).toContain('Повторить неуспешные ответы');
        expect(html).toContain('Продолжить с готовыми ответами');
    });
});
