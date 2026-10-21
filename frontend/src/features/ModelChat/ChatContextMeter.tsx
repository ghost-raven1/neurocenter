import {Progress, Spin, Typography} from 'antd';
import type {IModelChatCompaction, IModelChatContext, IModelChatTurn, IModelChatUsage} from './types';
import {modelChatContextBlocked} from './model';

interface Props {context?: IModelChatContext; loading: boolean; error?: string; rejected?: boolean; usage?: IModelChatUsage; compaction?: IModelChatCompaction; phase?: IModelChatTurn['processingStage']; failed?: boolean;}
const number = (value: number): string => value.toLocaleString('ru-RU');

/** Ordinary chat keeps one status line; estimates and transport diagnostics are explicitly expandable. */
export function ChatContextMeter({context, loading, error, rejected, usage, compaction, phase, failed}: Props): JSX.Element {
    const capacity = context?.contextWindowTokens, reserve = context?.reservedOutputTokens;
    const used = context ? context.estimatedInputTokens + (reserve ?? 0) : 0;
    const percent = capacity && reserve !== null ? Math.min(100, Math.round(used / capacity * 100)) : undefined;
    const running = !failed && (phase === 'compacting' || compaction?.state === 'compacting');
    const compressionFailed = failed && phase === 'compacting';
    const blocked = rejected || modelChatContextBlocked(context);
    const status = running ? 'Сжимаем раннюю переписку…' : compressionFailed ? 'Не удалось сжать контекст' : rejected ? 'Сообщение требует проверки' : blocked ? 'Сообщение не помещается в контекст'
        : context?.compactionNeeded && context.canCompact ? 'Сожмём раннюю переписку при отправке' : compaction?.state === 'ready' ? 'Контекст сжат · история сохранена' : context ? 'Оценка контекста' : 'Контекст';
    if (context?.participants) return <div className="model-chat__context" aria-label="Контекст участников">
        <details><summary><span role="status" aria-live="polite">{running && <Spin size="small"/>}{status} · {context.participants.length}</span><span className="model-chat__context-more">Окна участников</span></summary>
            <div className="model-chat__participant-budgets">{context.participants.map(participant => <div key={participant.agentId}><Typography.Text strong>{participant.name} · {participant.modelName}</Typography.Text><ChatContextMeter context={participant.context} loading={loading}/></div>)}</div>
        </details>{blocked && <Typography.Text type="danger" className="model-chat__context-error">{error || context.reason || 'Уменьшите сообщение или документы для выбранных адресатов.'}</Typography.Text>}
    </div>;
    return <div className="model-chat__context" aria-label="Контекст модели">
        <details>
            <summary><span className="model-chat__context-status" role="status" aria-live="polite">{running && <Spin size="small"/>}<Typography.Text type={blocked || compressionFailed ? 'warning' : undefined}>{status}</Typography.Text></span><span className="model-chat__context-more">Подробнее</span></summary>
            <div className="model-chat__context-details">
                <Typography.Text type="secondary">{loading ? 'Обновляем оценку…' : context ? `Оценка входа: ≈ ${number(context.estimatedInputTokens)} токенов.` : 'Оценка пока недоступна.'} {capacity ? `Окно модели: ${number(capacity)} токенов.` : context ? 'Провайдер не сообщил размер окна модели.' : 'Размер окна пока не указан.'}</Typography.Text>
                {percent !== undefined && <Progress percent={percent} showInfo={false} size="small" status={blocked ? 'exception' : 'normal'}/>}
                <Typography.Text type="secondary">{reserve != null ? `Резерв ответа: ${number(reserve)} токенов. ` : 'Резерв ответа не указан. '}Подсчёт приблизительный.</Typography.Text>
                {compaction && <Typography.Text type="secondary">{compaction.coveredTurns ? `Ранних обменов в сводке: ${number(compaction.coveredTurns)}. ` : ''}При необходимости ранняя переписка сжимается; полная история и документы сохраняются в диалоге.</Typography.Text>}
                {compressionFailed && <Typography.Text type="warning">Сжатие не завершилось. История сохранена; повторите запрос под последним сообщением.</Typography.Text>}
                {usage?.reported && <Typography.Text type="secondary">Последний запрос по данным API: вход {usage.inputTokens == null ? 'не указан' : number(usage.inputTokens)}, ответ {usage.outputTokens == null ? 'не указан' : number(usage.outputTokens)} токенов.</Typography.Text>}
                {context && <Typography.Text type="secondary">Предварительная оценка переписки и вложений: {context.messageCount} сообщений; {Math.ceil(context.requestBytes / 1024)} / {Math.floor(context.maxRequestBytes / 1024)} КиБ. Контекст проекта и результаты исследования добавляются при отправке. Это ограничения передачи, а не размер окна модели.</Typography.Text>}
                {error && !rejected && <Typography.Text type="warning">{error}</Typography.Text>}
            </div>
        </details>
        {blocked && <Typography.Text type="danger" className="model-chat__context-error">{error || context?.reason || 'Уменьшите последнее сообщение или вложения: сжатие ранней переписки не решит это ограничение.'}</Typography.Text>}
    </div>;
}
