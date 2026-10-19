import { Alert, Button, Space, Switch, Tag, Typography } from 'antd';
import { formatDate } from '../../common/utils/format';
import type { IFeatureFlagRowState } from './featureFlagsController';
import type { IFeatureFlag } from './types';

interface IProps {
    flag: IFeatureFlag; state: IFeatureFlagRowState; disabled: boolean;
    onChange: (enabled: boolean) => void; onRefresh: () => void; onUseCurrent: () => void;
}

/** Switch показывает подтверждённое серверное значение до ответа на PATCH. */
export function FeatureFlagRow({ flag, state, disabled, onChange, onRefresh, onUseCurrent }: IProps): JSX.Element {
    return <div className="feature-flags__row">
        <div className="feature-flags__setting">
            <div className="feature-flags__description">
                <Typography.Text strong>{flag.name}</Typography.Text>
                <Typography.Paragraph type="secondary">{flag.description}</Typography.Paragraph>
                <Space size={[8, 4]} wrap className="feature-flags__updated">
                    <Typography.Text type="secondary">{flag.updatedAt ? `Обновлено: ${formatDate(flag.updatedAt)}` : 'Изменений пока нет'}</Typography.Text>
                    {flag.updatedBy && <Typography.Text type="secondary">{flag.updatedBy === 'system:defaults' ? 'Начальная настройка' : `Изменил: ${flag.updatedBy}`}</Typography.Text>}
                </Space>
            </div>
            <Space className="feature-flags__control" size={12}>
                <Tag color={flag.enabled ? 'blue' : undefined}>{flag.enabled ? 'Включена' : 'Выключена'}</Tag>
                <Switch aria-label={flag.name} checked={flag.enabled} loading={state.saving} disabled={disabled || state.saving || state.needsReview}
                    checkedChildren="Вкл." unCheckedChildren="Выкл." onChange={onChange} />
            </Space>
        </div>
        {state.saving && <Typography.Text role="status" aria-live="polite" type="secondary">Сохраняем настройку…</Typography.Text>}
        {state.saved && <Typography.Text role="status" aria-live="polite" className="feature-flags__saved">Изменение подтверждено сервером</Typography.Text>}
        {state.error && <Alert showIcon type={state.needsReview ? 'warning' : 'error'} className="feature-flags__error"
            message={state.needsReview ? 'Настройку уже изменили' : 'Изменение не подтверждено'}
            description={<Space direction="vertical" size={8}>
                <span>{state.error}</span>
                <span>{state.needsReview ? 'Проверьте актуальное значение перед новым переключением. Изменение не повторяется автоматически.' : 'Проверьте серверное состояние перед повторной попыткой.'}</span>
                {state.needsReview ? <Button disabled={disabled || state.saving} onClick={onUseCurrent}>Использовать актуальное значение</Button>
                    : <Button disabled={disabled || state.saving} onClick={onRefresh}>Проверить состояние</Button>}
            </Space>} />}
    </div>;
}
