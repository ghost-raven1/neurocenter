import {Alert, Button, Card, Input, Space, Tag, Typography} from 'antd';
import {Link} from 'react-router-dom';
import {FeatureAvailabilityNotice, FeatureButton} from '../../features/FeatureFlags/FeatureAvailability';
import {useBridgeSourceDraft} from './useBridgeSourceDraft';

/** Configure the existing source without importing files or changing already prepared installers. */
export function BridgeSourceSettings(): JSX.Element {
    const source = useBridgeSourceDraft();
    const offline = source.data?.sourceMode === 'offline';
    return <Card title="Версии моста" id="sources" className="settings-page__source">
        <Space direction="vertical" size="middle" className="settings-page__content">
            <Typography.Paragraph type="secondary">Выберите публичный репозиторий поставок моста. Сохранение адреса не заменяет уже подготовленную версию и не обновляет компьютеры.</Typography.Paragraph>
            <FeatureAvailabilityNotice features={['asset_sources']}/>
            {offline ? <Alert type="info" showIcon message="Автономная поставка" description="Сервер получает версии из локальной поставки. Загрузите обновлённый архив на странице «Ассеты». Обращения к GitHub отключены."/>
                : <><label htmlFor="bridge-source-repository">Репозиторий версий моста</label>
                    <Input id="bridge-source-repository" value={source.url} maxLength={2048} disabled={source.blocked}
                        onChange={event => source.change(event.target.value)} placeholder="https://github.com/owner/neurocenter-assets" aria-describedby="bridge-source-description"/>
                    <Typography.Text id="bridge-source-description" type="secondary">HTTPS-ссылка на репозиторий neurocenter-assets или его fork, без токенов и ссылки на install.sh.</Typography.Text>
                    {source.stale && <Alert type="warning" showIcon message="Источник изменился на сервере" description={<Space direction="vertical">
                        <Typography.Text>Ваш адрес сохранён в поле. Актуальный адрес: <span className="settings-page__url">{source.data?.url}</span></Typography.Text>
                        <Space wrap><Button disabled={source.blocked} onClick={source.acceptCurrent}>Принять актуальный адрес</Button>
                            <Button disabled={source.blocked} onClick={source.keepDraft}>Оставить мой вариант</Button></Space>
                    </Space>}/>}
                    <Space wrap><FeatureButton features={['asset_sources']} type="primary" loading={source.saving} disabled={source.blocked || !source.changed || source.stale} onClick={() => { void source.saveDraft(); }}>Сохранить источник</FeatureButton>
                        <FeatureButton features={['asset_sources']} loading={source.checking} disabled={source.blocked || source.changed || source.stale} onClick={() => { void source.check(); }}>Проверить версии</FeatureButton>
                        <Button loading={source.loading && !source.checking} disabled={source.saving} onClick={() => { void source.reload(); }}>Обновить сведения</Button></Space>
                </>}
            {(source.error || source.data?.error) && <Alert type="warning" showIcon message={source.error || source.data?.error}
                description="Проверьте адрес и повторите действие. Введённый адрес и подготовленная поставка сохраняются."/>
            }
            {source.data?.importedError && <Alert type="warning" showIcon message={source.data.importedError}/>}
            <div className="settings-page__versions"><Typography.Text>Найдена в источнике: <Tag>{source.data?.available?.version ?? 'ещё не проверено'}</Tag></Typography.Text>
                <Typography.Text>Подготовлена на сервере: <Tag>{source.data?.imported?.version ?? 'пока нет'}</Tag></Typography.Text></div>
            <Typography.Paragraph type="secondary">Выбор ассетов, импорт архива и результаты подготовки доступны на странице <Link to="/assets">«Ассеты»</Link>. Установить мост на компьютер можно в разделе <Link to="/start?step=1">«Начало работы»</Link>.</Typography.Paragraph>
        </Space>
    </Card>;
}
