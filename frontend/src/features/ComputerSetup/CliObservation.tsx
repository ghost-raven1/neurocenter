import {Button, Space, Spin, Tag, Typography} from 'antd';
import type {useBridge} from '../McpBridge/useBridge';
import {cliTerminal} from './model';
import {useCliObservation} from './useCliObservation';
import {cliObservationPresentation} from './presentation';

/** Compact status reports only the selected computer's validated receipt, never a model or installer result. */
export function CliObservation({bridge, canStart: masterEnabled}: {bridge: ReturnType<typeof useBridge>; canStart: boolean}): JSX.Element {
    return <CliObservationDetails control={useCliObservation(bridge, masterEnabled)}/>;
}

/** Reuse the shell's controller without mounting another automatic observation. */
export function CliObservationDetails({control}: {control: ReturnType<typeof useCliObservation>}): JSX.Element {
    const {state, controller, blocker, canStart, canCancel, roleChanged} = control;
    const {job} = state, {label, observation, running, unknown, notice} = cliObservationPresentation(state);
    return <div className="cli-observation" role="group" aria-label="Проверка OpenCode на выбранном компьютере">
        <Space className="cli-observation__summary" size={[8, 6]} wrap>
            {(state.reading || running) && <Spin size="small"/>}
            <span role="status"><Tag color={observation?.status === 'installed' ? 'green' : observation?.status === 'missing' ? 'orange' : undefined}>{label}</Tag></span>
            {observation && <Typography.Text type="secondary">Проверено {new Date(observation.checkedAt).toLocaleString('ru-RU')}</Typography.Text>}
        </Space>
        <div className="cli-observation__actions">{running ? <Button size="small" type="link" disabled={state.busy || !canCancel || state.denied} onClick={() => {void controller.cancel();}}>Отменить проверку</Button>
                : unknown || notice || !canStart ? <Button size="small" type="link" loading={state.busy} onClick={() => {void controller.refresh().then(() => controller.automatic());}}>{unknown ? 'Проверить отправку' : 'Обновить состояние'}</Button>
                    : <Button size="small" type="link" loading={state.busy} disabled={!canStart || state.denied} onClick={() => {void controller.start();}}>{job ? 'Проверить снова' : 'Проверить OpenCode'}</Button>}</div>
        {notice && <Typography.Paragraph role="status" type="warning" style={{marginBottom: 0}}>{notice}</Typography.Paragraph>}
        {blocker && <Typography.Paragraph type="secondary" style={{marginBottom: 0}}>{blocker}</Typography.Paragraph>}
        {roleChanged && !cliTerminal(job) && <Typography.Paragraph type="secondary" style={{marginBottom: 0}}>Для повтора сохранённой отправки выберите исходную активную роль. Чтение её состояния остаётся доступным.</Typography.Paragraph>}
        {state.canReplay && <Button size="small" type="link" disabled={state.busy || !canStart || roleChanged} onClick={() => {void controller.replay();}}>Повторить сохранённый запрос</Button>}
        {job && <details><summary>Последняя проверка</summary><Typography.Text type="secondary">Задание {job.id} · {new Date(job.updatedAt).toLocaleString('ru-RU')}</Typography.Text></details>}
    </div>;
}
