import {Button, Card, Slider, Space, Switch, Typography} from 'antd';
import {SoundOutlined} from '@ant-design/icons';
import {useId} from 'react';
import {useNotificationSoundSettings} from './useNotificationSounds';
import './NotificationSounds.less';

/** The same account-local controls appear in Settings and the authenticated user menu. */
export function NotificationSoundSettings({embedded = false}: {embedded?: boolean}): JSX.Element {
    const {state, flag, change, test} = useNotificationSoundSettings();
    const volumeLabel = useId();
    // Ant Design 4 forwards these documented rc-slider handle names but omits them from its own type surface.
    const volumeAccessibility = {ariaLabelledByForHandle: volumeLabel, ariaLabelForHandle: 'Громкость уведомлений'};
    const status = state?.status === 'unsupported' ? 'Этот браузер не поддерживает звук уведомлений.'
        : state?.status === 'blocked' ? 'Браузер пока не разрешил звук. Нажмите «Проверить звук».'
        : state?.volume === 0 ? 'Громкость 0% — без звука.' : 'Если звук не слышен, нажмите «Проверить звук».';
    const content = <div className="notification-sounds">
        <div className="notification-sounds__switch"><div><Typography.Text strong>Звук уведомлений</Typography.Text><Typography.Paragraph type="secondary">Короткий сигнал о новом ответе или завершении фоновой задачи.</Typography.Paragraph></div>
            <Switch aria-label="Звук уведомлений" checked={state?.enabled ?? false} disabled={!state} onChange={enabled => change({enabled})}/></div>
        <div className="notification-sounds__volume"><label id={volumeLabel}>Громкость</label><span aria-live="polite">{state?.volume ?? 50}%</span>
            <Slider {...volumeAccessibility} range={false} min={0} max={100} value={state?.volume ?? 50} disabled={!state} onChange={volume => change({volume})}/></div>
        <Space wrap><Button icon={<SoundOutlined/>} disabled={!state || !state.volume || !flag.enabled || state.status === 'unsupported'} loading={state?.busy} onClick={test}>Проверить звук</Button><Typography.Text type="secondary">Проверка не включает автоматический звук.</Typography.Text></Space>
        <Typography.Paragraph className="notification-sounds__status" role="status" aria-live="polite" type="secondary">{!flag.enabled ? flag.reason : status}</Typography.Paragraph>
        <Typography.Text type="secondary">{state?.persisted === false ? 'Браузер не сохранил выбор. Настройка действует в текущей сессии.' : 'Личная настройка на этом браузере.'}</Typography.Text>
    </div>;
    return embedded ? content : <Card size="small" title="Уведомления" className="notification-sounds-card">{content}</Card>;
}
