import {Progress, Spin, Typography} from 'antd';
import type {IModelChatCompaction, IModelChatContext, IModelChatTurn, IModelChatUsage} from './types';
import {modelChatContextBlocked} from './model';
import {ChatToolPopover} from './ChatToolPopover';

interface Props {context?: IModelChatContext; loading: boolean; error?: string; rejected?: boolean; usage?: IModelChatUsage; compaction?: IModelChatCompaction; phase?: IModelChatTurn['processingStage']; failed?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void;}
const number = (value: number): string => value.toLocaleString('ru-RU');

/** A compact status stays in the toolbar; participant budgets share one bounded floating panel. */
export function ChatContextMeter(props: Props): JSX.Element {
    const {context, error, rejected, compaction, phase, failed, open = false, onOpenChange = () => undefined} = props;
    const running = !failed && (phase === 'compacting' || compaction?.state === 'compacting');
    const compressionFailed = failed && phase === 'compacting', blocked = rejected || modelChatContextBlocked(context);
    const status = running ? 'Сжимаем раннюю переписку…' : compressionFailed ? 'Не удалось сжать контекст' : rejected ? 'Сообщение требует проверки' : blocked ? 'Сообщение не помещается в контекст'
        : context?.compactionNeeded && context.canCompact ? 'Сожмём раннюю переписку при отправке' : compaction?.state === 'ready' ? 'Контекст сжат · история сохранена' : context ? 'Оценка контекста' : 'Контекст';
    const warning = blocked ? error || context?.reason || (context?.participants ? 'Уменьшите сообщение или документы для выбранных адресатов.' : 'Уменьшите последнее сообщение или вложения: сжатие ранней переписки не решит это ограничение.')
        : compressionFailed ? 'Сжатие не завершилось. История сохранена; повторите запрос под последним сообщением.' : error;
    return <div className="model-chat__context" aria-label={context?.participants ? 'Контекст участников' : 'Контекст модели'}>
        <ChatToolPopover label={`${status}${context?.participants ? ` · ${context.participants.length}` : ''}`} open={open} onOpenChange={onOpenChange}>
            {context?.participants ? <div className="model-chat__participant-budgets">{context.participants.map(participant => <section key={participant.agentId}>
                <Typography.Text strong>{participant.name} · {participant.modelName}</Typography.Text><ContextDetails context={participant.context} loading={props.loading}/>
                {modelChatContextBlocked(participant.context) && <Typography.Text type="danger">{participant.context.reason}</Typography.Text>}
            </section>)}</div> : <ContextDetails {...props}/>}
        </ChatToolPopover>
        {running && <Spin size="small"/>}
        <div id="model-chat-context-status" role="status" aria-live="polite"><span className="model-chat__context-announcement">{status}</span>
            {warning && <Typography.Text type={blocked ? 'danger' : 'warning'} className="model-chat__context-error">{warning}</Typography.Text>}
        </div>
    </div>;
}

/** Read-only budget details are inline within the single context panel, including group members. */
function ContextDetails({context, loading, usage, compaction}: Props): JSX.Element {
    const capacity = context?.contextWindowTokens, reserve = context?.reservedOutputTokens;
    const used = context ? context.estimatedInputTokens + (reserve ?? 0) : 0;
    const percent = capacity && reserve !== null ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    return <div className="model-chat__context-details">
                <Typography.Text type="secondary">{loading ? 'Обновляем оценку…' : context ? `Оценка входа: ≈ ${number(context.estimatedInputTokens)} токенов.` : 'Оценка пока недоступна.'} {capacity ? `Окно модели: ${number(capacity)} токенов.` : context ? 'Провайдер не сообщил размер окна модели.' : 'Размер окна пока не указан.'}</Typography.Text>
                {percent !== undefined && <Progress percent={percent} showInfo={false} size="small" status={modelChatContextBlocked(context) ? 'exception' : 'normal'}/>}
                <Typography.Text type="secondary">{reserve != null ? `Резерв ответа: ${number(reserve)} токенов. ` : 'Резерв ответа не указан. '}Подсчёт приблизительный.</Typography.Text>
                {compaction && <Typography.Text type="secondary">{compaction.coveredTurns ? `Ранних обменов в сводке: ${number(compaction.coveredTurns)}. ` : ''}При необходимости ранняя переписка сжимается; полная история и документы сохраняются в диалоге.</Typography.Text>}
                {usage?.reported && <Typography.Text type="secondary">Последний запрос по данным API: вход {usage.inputTokens == null ? 'не указан' : number(usage.inputTokens)}, ответ {usage.outputTokens == null ? 'не указан' : number(usage.outputTokens)} токенов.</Typography.Text>}
                {context && <Typography.Text type="secondary">Предварительная оценка переписки и вложений: {context.messageCount} сообщений; {Math.ceil(context.requestBytes / 1024)} / {Math.floor(context.maxRequestBytes / 1024)} КиБ. Контекст проекта и результаты исследования добавляются при отправке. Это ограничения передачи, а не размер окна модели.</Typography.Text>}
    </div>;
}
