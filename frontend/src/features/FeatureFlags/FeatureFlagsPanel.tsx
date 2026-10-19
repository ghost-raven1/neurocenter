import { ControlOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { authDataScope } from '../UserBlock/authDataScope';
import { FeatureFlagRow } from './FeatureFlagRow';
import { useFeatureFlags } from './useFeatureFlags';
import './FeatureFlags.less';

function AccountFeatureFlags(): JSX.Element {
    const { items, rows, loading, readError, refresh, save, useCurrent } = useFeatureFlags();
    const saving = Object.values(rows).some(row => row.saving);
    return <Card className="feature-flags" title={<Space><ControlOutlined /><span>Функции платформы</span></Space>}
        extra={<Button loading={loading} disabled={saving} onClick={() => { void refresh(); }}>Обновить функции</Button>}>
        <Typography.Paragraph className="feature-flags__intro">Изменения применяются к новым запросам. Выполняющиеся запросы не прерываются. Чтение данных, просмотр состояния и выгрузка моделей из памяти остаются доступны.</Typography.Paragraph>
        {readError && <Alert showIcon type={items ? 'warning' : 'error'} className="feature-flags__error"
            message={items ? 'Не удалось обновить функции — показаны последние данные' : 'Состояние функций недоступно'} description={readError}
            action={<Button loading={loading} disabled={saving} onClick={() => { void refresh(); }}>Повторить загрузку</Button>} />}
        {!items && loading && <div className="feature-flags__loading"><Spin tip="Загружаем функции…" /></div>}
        {items?.map(flag => <FeatureFlagRow key={flag.key} flag={flag} state={rows[flag.key]} disabled={loading || !!readError}
            onChange={enabled => { void save(flag.key, enabled); }} onRefresh={() => { void refresh(); }} onUseCurrent={() => useCurrent(flag.key)} />)}
    </Card>;
}

/** Раздел принадлежит активному главному администратору и не переносит данные между ролями. */
export function FeatureFlagsPanel(): JSX.Element | null {
    const { user, policies } = useSelector((state: RootState) => state.userBlock);
    if (!user || user.activeRole !== 'Главный админ' || !user.userRoles.includes(user.activeRole)) return null;
    return <AccountFeatureFlags key={authDataScope({ user, policies })} />;
}
