import { Alert, Button, Space, Switch, Tag, Typography } from 'antd';
import { formatDate } from '../../common/utils/format';
import type { IFeatureFlagRowState } from './featureFlagsController';
import { featureDefinition } from './types';
import type { IFeatureFlag, TFeatureFlagKey } from './types';

interface IProps {
    flag: IFeatureFlag; state: IFeatureFlagRowState; disabled: boolean;
    blockedBy?: TFeatureFlagKey[];
    onChange: (enabled: boolean) => void; onRefresh: () => void; onUseCurrent: () => void; onRetryChoice: () => void;
}

/** Switch показывает подтверждённое серверное значение до ответа на PATCH. */
export function FeatureFlagRow({ flag, state, disabled, blockedBy = [], onChange, onRefresh, onUseCurrent, onRetryChoice }: IProps): JSX.Element {
    const choice = state.choice, reviewed = !!choice && choice.reviewedRevision === flag.revision;
    const matches = !!choice && choice.enabled === flag.enabled;
    return <div className="feature-flags__row">
        <div className="feature-flags__setting">
            <div className="feature-flags__description">
                <Typography.Text strong>{flag.name}</Typography.Text>
                <Typography.Paragraph type="secondary">{flag.description}</Typography.Paragraph>
                {flag.enabled && blockedBy.length > 0 && <Typography.Paragraph className="feature-flags__dependency" role="status">Настройка включена, но функция недоступна: выключено {blockedBy.map(key => `«${featureDefinition(key).name}»`).join(', ')}. Переключатель этой функции сохраняется.</Typography.Paragraph>}
                {flag.dependsOn.length > 0 && <Typography.Paragraph type="secondary" className="feature-flags__dependencies">Зависит от: {flag.dependsOn.map(key => featureDefinition(key).name).join(', ')}</Typography.Paragraph>}
                <Space size={[8, 4]} wrap className="feature-flags__updated">
                    <Typography.Text type="secondary">{flag.updatedAt ? `Обновлено: ${formatDate(flag.updatedAt)}` : 'Изменений пока нет'}</Typography.Text>
                    {flag.updatedBy && <Typography.Text type="secondary">{flag.updatedBy === 'system:defaults' ? 'Начальная настройка' : `Изменил: ${flag.updatedBy}`}</Typography.Text>}
                </Space>
            </div>
            <Space className="feature-flags__control" size={12}>
                <Tag color={flag.enabled ? blockedBy.length ? 'gold' : 'blue' : undefined}>{flag.enabled ? blockedBy.length ? 'Заблокирована' : 'Включена' : 'Выключена'}</Tag>
                <Switch aria-label={flag.name} checked={flag.enabled} loading={state.saving} disabled={disabled || state.saving || state.needsReview || !!choice}
                    checkedChildren="Вкл." unCheckedChildren="Выкл." onChange={onChange} />
            </Space>
        </div>
        {state.saving && <Typography.Text role="status" aria-live="polite" type="secondary">Сохраняем настройку…</Typography.Text>}
        {state.saved && <Typography.Text role="status" aria-live="polite" className="feature-flags__saved">Изменение подтверждено сервером</Typography.Text>}
        {choice && !state.saving && <Alert showIcon type={state.error && !state.needsReview ? 'error' : 'warning'} className="feature-flags__error"
            message={reviewed && matches ? 'Текущее значение соответствует вашему выбору' : state.needsReview ? 'Настройку уже изменили' : 'Выбор сохранён в этой панели'}
            description={<Space direction="vertical" size={8}>
                {state.error && <span>{state.error}</span>}
                <span>Ваш выбор: {choice.enabled ? 'включить' : 'выключить'}.</span>
                <span>{reviewed ? matches ? 'Совпадение не подтверждает результат предыдущего запроса.'
                    : 'Примените сохранённый выбор вручную или оставьте серверное значение.'
                    : 'Сначала проверьте серверное состояние. Изменение не повторяется автоматически.'}</span>
                <Space wrap>
                    <Button disabled={disabled} onClick={onRefresh}>Проверить состояние</Button>
                    {reviewed && !matches && <Button disabled={disabled} onClick={onRetryChoice}>Применить сохранённый выбор</Button>}
                    <Button disabled={disabled || !reviewed} onClick={onUseCurrent}>Оставить серверное значение</Button>
                </Space>
            </Space>} />}
        {!choice && state.error && <Alert showIcon type={state.needsReview ? 'warning' : 'error'} className="feature-flags__error"
            message={state.needsReview ? 'Настройку уже изменили' : 'Изменение не подтверждено'}
            description={<Space direction="vertical" size={8}>
                <span>{state.error}</span>
                <span>{state.needsReview ? 'Проверьте актуальное значение перед новым переключением. Изменение не повторяется автоматически.' : 'Проверьте серверное состояние перед повторной попыткой.'}</span>
                {state.needsReview ? <Button disabled={disabled || state.saving} onClick={onUseCurrent}>Использовать актуальное значение</Button>
                    : <Button disabled={disabled || state.saving} onClick={onRefresh}>Проверить состояние</Button>}
            </Space>} />}
    </div>;
}
