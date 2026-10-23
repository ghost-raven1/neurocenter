import {CopyOutlined} from '@ant-design/icons';
import {Alert, Button, Spin, Typography} from 'antd';
import {useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {ChatResearchActivity} from './ChatResearchActivity';
import {ChatProjectContext} from './ChatProjectContext';
import {modelChatUrl} from './model';
import {useFeatureAvailability} from '../FeatureFlags/FeatureAvailability';
import type {IModelChatAnswer, IModelChatTurn, IChatResearchStepSummary} from './types';

interface Props {name: string; answer?: IModelChatAnswer; status: IModelChatTurn['status']; executionState?: IModelChatTurn['executionState']; phase?: IModelChatTurn['processingStage']; error?: string; group?: boolean; modelName?: string; researchSteps?: IChatResearchStepSummary[]; conversationId?: string;}

/** Each saved response keeps its author, evidence and copy action, including partial group rounds. */
export function ChatAnswer({name, answer, status, executionState, phase, error, group, modelName, researchSteps, conversationId}: Props): JSX.Element {
    const [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
    const activity = useFeatureAvailability('chat_activity');
    const copy = async (): Promise<void> => {
        if (!answer) return;
        try {await navigator.clipboard.writeText(answer.content); setCopied(true); setCopyError('');}
        catch {setCopyError('Не удалось скопировать ответ. Выделите текст и скопируйте его вручную.');}
    };
    return <article className="model-chat__message model-chat__message_assistant" aria-label={group ? `Ответ агента ${name}` : 'Ответ модели'}>
        <div className="model-chat__message-heading"><div><Typography.Text strong>{name}</Typography.Text>{group && modelName && <Typography.Text type="secondary" className="model-chat__answer-model">{modelName}</Typography.Text>}</div>
            {answer && <Button size="small" type="text" icon={<CopyOutlined/>} onClick={() => {void copy();}} aria-label={group ? `Скопировать ответ · ${name}` : 'Скопировать ответ'}>{copied ? 'Скопировано' : 'Копировать'}</Button>}</div>
        {answer && <div className="model-chat__markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => modelChatUrl(url) ?? ''} components={{
            a: ({href, children}) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
            img: ({alt}) => <span>Изображение: {alt || 'без подписи'}</span>,
            table: ({children}) => <div className="model-chat__table" tabIndex={0}><table>{children}</table></div>,
        }}>{answer.content}</Markdown></div>}
        {status === 'pending' && <div role="status" className="model-chat__pending"><Spin size="small"/> {phase === 'researching' ? 'Исследуем источники…' : phase === 'compacting' ? 'Сжимаем раннюю переписку…' : !activity.enabled ? 'Ожидаем ответ…' : executionState === 'running' ? `${group ? name : 'Модель'} готовит ответ…` : executionState === undefined ? 'Уточняем состояние ответа…' : group ? 'Ожидаем начало ответа агента…' : 'Ожидаем начало ответа…'}</div>}
        {answer?.finishReason === 'length' && <Alert type="warning" showIcon message="Ответ достиг лимита токенов. Можно попросить модель продолжить."/>}
        {['failed', 'cancelled'].includes(status) && <Alert type={status === 'cancelled' ? 'info' : 'error'} showIcon message={status === 'failed' && phase === 'compacting' ? 'Не удалось сжать раннюю переписку. История сохранена; повторите запрос.' : error || (status === 'cancelled' ? 'Запрос остановлен.' : 'Ответ не получен.')}/>}
        {answer?.researchLimited && <Typography.Paragraph type="warning">Достигнут предел шагов исследования. Ответ основан на собранных данных и может требовать дополнительной проверки.</Typography.Paragraph>}
        {!!answer?.researchSources?.length && <details className="model-chat__project-context"><summary>Внешние источники · {answer.researchSources.length}</summary><ol>{answer.researchSources.map(source => {const url = modelChatUrl(source.url); return url ? <li key={source.url}><a href={url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a></li> : null;})}</ol></details>}
        <ChatResearchActivity steps={researchSteps} conversationId={conversationId}/>
        <ChatProjectContext evidence={answer?.evidence} answer/>
        {copyError && <Alert type="warning" message={copyError}/>}
    </article>;
}
