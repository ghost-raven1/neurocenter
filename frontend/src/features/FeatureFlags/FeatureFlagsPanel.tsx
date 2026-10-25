import { ControlOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Input, Space, Spin, Typography } from 'antd';
import {useState} from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { authDataScope } from '../UserBlock/authDataScope';
import { FeatureFlagRow } from './FeatureFlagRow';
import { useFeatureFlags } from './useFeatureFlags';
import { configuredBlockers, featureGroups, type IFeatureFlag } from './types';
import './FeatureFlags.less';

function AccountFeatureFlags(): JSX.Element {
    const { items, rows, loading, readError, refresh, save, retryChoice, useCurrent: applyCurrent } = useFeatureFlags();
    const saving = Object.values(rows).some(row => row.saving);
    const [query, setQuery] = useState('');
    const matches = (flag: IFeatureFlag): boolean => !query.trim() || `${flag.name} ${flag.description} ${flag.key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) || !!(rows[flag.key]?.saving || rows[flag.key]?.error || rows[flag.key]?.choice);
    const visible = items?.filter(matches).length ?? 0;
    return <Card className="feature-flags" title={<Space><ControlOutlined /><span>Функции платформы</span></Space>}
        extra={<Button loading={loading} disabled={saving} onClick={() => { void refresh(); }}>Обновить функции</Button>}>
        <Typography.Paragraph className="feature-flags__intro">Изменения применяются к новым запросам. Выполняющиеся запросы не прерываются. Чтение данных, просмотр состояния и выгрузка моделей из памяти остаются доступны.</Typography.Paragraph>
        {readError && <Alert showIcon type={items ? 'warning' : 'error'} className="feature-flags__error"
            message={items ? 'Не удалось обновить функции — показаны последние данные' : 'Состояние функций недоступно'} description={readError}
            action={<Button loading={loading} disabled={saving} onClick={() => { void refresh(); }}>Повторить загрузку</Button>} />}
        {!items && loading && <div className="feature-flags__loading"><Spin tip="Загружаем функции…" /></div>}
        {items && <Space wrap className="feature-flags__filter"><Input.Search aria-label="Поиск функций платформы" placeholder="Найти функцию…" allowClear value={query} onChange={event => setQuery(event.target.value)} /><Typography.Text type="secondary" role="status">Показано {visible} из {items.length}{query && ' · операции и ошибки остаются видимыми'}</Typography.Text></Space>}
        {items && visible === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Функции не найдены" />}
        {items && featureGroups.filter(group => items.some(flag => flag.group === group.key)).map(group => <section key={group.key} className="feature-flags__group" aria-label={group.name} hidden={!items.some(flag => flag.group === group.key && matches(flag))}>
            <Typography.Title level={4}>{group.name}</Typography.Title>
            {items.filter(flag => flag.group === group.key).map(flag => <div key={flag.key} hidden={!matches(flag)}><FeatureFlagRow flag={flag} state={rows[flag.key]} disabled={loading || !!readError}
                blockedBy={configuredBlockers(flag.key, items)} onChange={enabled => { void save(flag.key, enabled); }} onRefresh={() => { void refresh(); }}
                onRetryChoice={() => { void retryChoice(flag.key); }} onUseCurrent={() => applyCurrent(flag.key)} /></div>)}
        </section>)}
    </Card>;
}

/** Раздел принадлежит активному главному администратору и не переносит данные между ролями. */
export function FeatureFlagsPanel(): JSX.Element | null {
    const { user, policies } = useSelector((state: RootState) => state.userBlock);
    if (!user || user.activeRole !== 'Главный админ' || !user.userRoles.includes(user.activeRole)) return null;
    return <AccountFeatureFlags key={authDataScope({ user, policies })} />;
}
