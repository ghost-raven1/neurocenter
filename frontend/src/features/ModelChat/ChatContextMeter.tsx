import {Progress, Tooltip, Typography} from 'antd';
import type {IModelChatContext, IModelChatUsage} from './types';

interface Props {context?: IModelChatContext; loading: boolean; error?: string; usage?: IModelChatUsage;}
const number = (value: number): string => value.toLocaleString('ru-RU');

/** Token estimates and transport bounds are separate, and unknown capacity has no invented percentage. */
export function ChatContextMeter({context, loading, error, usage}: Props): JSX.Element {
    const capacity = context?.contextWindowTokens, reserve = context?.reservedOutputTokens;
    const used = context ? context.estimatedInputTokens + (reserve ?? 0) : 0;
    const percent = capacity && reserve !== null ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    return <div className="model-chat__context" aria-label="Контекст модели" aria-live="polite">
        <div className="model-chat__context-line"><Typography.Text strong>Контекст</Typography.Text>
            <Typography.Text type="secondary">{loading ? 'Оцениваем…' : context ? `≈ ${number(context.estimatedInputTokens)} токенов` : 'Оценка недоступна'}{capacity ? ` / ${number(capacity)}` : ' · окно модели неизвестно'}</Typography.Text></div>
        {percent !== undefined && <Progress percent={percent} showInfo={false} size="small" status={context?.exceeded ? 'exception' : 'normal'}/>}
        <Typography.Text type="secondary" className="model-chat__context-description">{reserve != null ? `Резерв ответа: ${number(reserve)} токенов. ` : 'Лимит ответа не указан. '}Подсчёт приблизительный; история и документы не обрезаются автоматически.</Typography.Text>
        {context && <Tooltip title="Это ограничения передачи данных, а не размер контекстного окна модели."><Typography.Text type="secondary" className="model-chat__context-description">Передача: {context.messageCount} / {context.maxMessages} сообщений · {Math.ceil(context.requestBytes / 1024)} / {Math.floor(context.maxRequestBytes / 1024)} КиБ</Typography.Text></Tooltip>}
        {usage?.reported && <Typography.Text type="secondary" className="model-chat__context-description">Последний запрос по данным API: вход {usage.inputTokens == null ? 'не указан' : number(usage.inputTokens)}, ответ {usage.outputTokens == null ? 'не указан' : number(usage.outputTokens)} токенов.</Typography.Text>}
        {context?.exceeded && <Typography.Text type="danger">{context.reason || 'Контекст превышает допустимый предел. Уберите вложение или начните новый диалог.'}</Typography.Text>}
        {error && <Typography.Text type="warning">{error}</Typography.Text>}
    </div>;
}
