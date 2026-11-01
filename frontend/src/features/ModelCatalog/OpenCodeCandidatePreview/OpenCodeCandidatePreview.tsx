import { Tag, Typography } from 'antd';
import { isRemoteApiUrl } from '../remoteModelForm';
import type { IOpenCodeCandidatePreviewProps } from './interfaces';

/** Preview public metadata before importing the selected provider/model; credentials remain on the computer. */
export function OpenCodeCandidatePreview({
    candidate,
    localCodex,
    blockerReason,
}: IOpenCodeCandidatePreviewProps): JSX.Element {
    return (
        <div>
            <Typography.Text strong>{candidate.name}</Typography.Text>
            <div>
                <Typography.Text type="secondary">
                    {candidate.provider} · {candidate.model}
                </Typography.Text>
            </div>
            {candidate.baseUrl && isRemoteApiUrl(candidate.baseUrl) && (
                <Typography.Paragraph>Адрес API: {candidate.baseUrl}</Typography.Paragraph>
            )}
            <Tag>{candidate.capability === 'vision' ? 'Изображения' : 'Чат'}</Tag>
            {candidate.options && Object.keys(candidate.options).length > 0 && (
                <div>
                    <Typography.Text type="secondary">
                        {[
                            candidate.options.apiFormat
                                ? `API: ${candidate.options.apiFormat === 'responses' ? 'Responses' : 'Chat Completions'}`
                                : undefined,
                            candidate.options.reasoningEffort
                                ? `Рассуждения: ${candidate.options.reasoningEffort}`
                                : undefined,
                            candidate.options.store !== undefined
                                ? `Хранение ответа: ${candidate.options.store ? 'включено' : 'выключено'}`
                                : undefined,
                            candidate.options.temperature != null
                                ? `Температура: ${candidate.options.temperature}`
                                : undefined,
                            candidate.options.topP != null ? `Top P: ${candidate.options.topP}` : undefined,
                            candidate.options.maxOutputTokens != null
                                ? `Ответ: до ${candidate.options.maxOutputTokens} токенов`
                                : undefined,
                            candidate.options.contextWindow != null
                                ? `Контекст: ${candidate.options.contextWindow} токенов`
                                : undefined,
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </Typography.Text>
                </div>
            )}
            {candidate.outputTokenLimit != null && (
                <div>
                    <Typography.Text type="secondary">
                        Предел ответа модели: {candidate.outputTokenLimit} токенов
                    </Typography.Text>
                </div>
            )}
            {candidate.timeoutMs != null && (
                <div>
                    <Typography.Text type="secondary">Ожидание ответа: {candidate.timeoutMs} мс</Typography.Text>
                </div>
            )}
            {localCodex ? (
                <Typography.Text type="secondary">Вход Codex остаётся на компьютере</Typography.Text>
            ) : (
                candidate.hasKey && (
                    <Typography.Text type="secondary">Этот импорт не передаёт ключ с компьютера</Typography.Text>
                )
            )}
            {candidate.parameterIssues?.length && (
                <div>
                    <Typography.Text type="secondary">
                        Параметры без подтверждённого преобразования:{' '}
                        {candidate.parameterIssues.map((item) => `${item.name} (${item.type})`).join(', ')}. Значения
                        сохранены в исходном OpenCode на компьютере; автоматический импорт заблокирован.
                        {!localCodex && ' Для серверного API задайте соответствующие поля в JSON параметров адаптера.'}
                    </Typography.Text>
                </div>
            )}
            {candidate.blocker && !localCodex && (
                <div>
                    <Typography.Text type="secondary">{blockerReason || 'Настройте API вручную'}</Typography.Text>
                </div>
            )}
        </div>
    );
}
