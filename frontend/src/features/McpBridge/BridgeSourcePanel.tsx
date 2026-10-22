import { Alert, Button, Collapse, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { IBridgeDevice } from './api';
import { bridgeDeviceTarget, compareBridgeVersions, type IBridgeSourceRelease } from './bridgeSource';
import { useBridgeSource } from './useBridgeSource';
import { useBridgeSourceImport } from './useBridgeSourceImport';
import type { IBridgeInstaller } from './useBridgeInstaller';
import { activeImport } from '../AssetSources/types';
import './BridgeSourcePanel.less';

/** Новая опись ещё не меняет работающий установщик; одинаковая версия с иным комплектом — конфликт. */
export function bridgeSupplyStatus(available?: IBridgeSourceRelease, imported?: IBridgeSourceRelease) {
    if (!available) return 'unknown';
    if (!imported) return 'available';
    const compared = compareBridgeVersions(imported.version, available.version);
    if (compared === undefined) return 'unknown';
    if (compared > 0) return 'older';
    if (compared < 0) return 'available';
    return imported.buildId === available.buildId ? 'ready' : 'conflict';
}

/** Отдельно показывает найденную, подготовленную на сервере и сообщённую компьютером версии. */
export function BridgeSourcePanel({ installer, device, verified, windows, canManage, onInstall }: {
    installer: IBridgeInstaller; device?: IBridgeDevice; verified: boolean; windows: boolean; canManage: boolean; onInstall: () => void;
}) {
    const source = useBridgeSource();
    const imports = useBridgeSourceImport(() => { void source.reload(); });
    const [url, setUrl] = useState('');
    const [resolving, setResolving] = useState<{jobId: string; digest: string; revision: number}>();
    const data = source.data;
    const offline = data?.sourceMode === 'offline';
    useEffect(() => { setUrl(data?.url ?? ''); }, [data?.url, data?.revision]);
    const status = bridgeSupplyStatus(data?.available, data?.imported);
    const fresh = !offline && !!data?.checkedAt && !data.error && !source.error && !source.loading;
    const devSupply = installer.devSupply;
    const installSupply = devSupply ?? data?.imported;
    const target = bridgeDeviceTarget(device);
    const targetSupported = !target || !!installSupply?.targets.includes(target);
    const installedVersion = device?.report.bridgeVersion;
    const installedComparison = installSupply ? compareBridgeVersions(installedVersion, installSupply.version) : undefined;
    const differentBuild = installedComparison === 0 && !!device?.report.buildId && device.report.buildId !== installSupply?.buildId;
    const installerReady = !!installer.origin && !installer.loading && !installer.error;
    const canInstall = installerReady && !!installSupply && targetSupported && !(installedComparison !== undefined && installedComparison > 0) && (!!devSupply || !differentBuild);
    const devUpdate = !!devSupply && (installedComparison === -1 || differentBuild);
    const sourceBusy = source.loading || source.saving || imports.blocked || !!imports.job;
    const installerUrl = installerReady ? `${installer.origin}/api/bridge/install.${windows ? 'ps1' : 'sh'}` : undefined;
    const conflicts = imports.job?.items.filter(item => item.action === 'conflict') ?? [];
    const matchesSource = !!data && imports.intent?.expectedRevision === data.revision;
    const replaceable = matchesSource && imports.job?.state === 'NEEDS_INPUT' && conflicts.length > 0 && conflicts.every(item => !!item.replacement);
    const confirming = !!resolving && resolving.jobId === imports.job?.id && resolving.digest === imports.job?.planDigest && resolving.revision === data?.revision;
    const liveConfirmation = useRef({jobId: imports.job?.id, digest: imports.job?.planDigest, revision: data?.revision, canManage});
    liveConfirmation.current = {jobId: imports.job?.id, digest: imports.job?.planDigest, revision: data?.revision, canManage};
    return <div className="bridge-source" aria-label="Версии и установщик моста">
        <div className="bridge-source__versions" role="status">
            <Typography.Text>{device ? `${verified && device.online ? 'Установлено' : 'Последний отчёт'}: ${installedVersion || 'версия пока неизвестна'}` : 'Компьютер ещё не выбран'}</Typography.Text>
            {(!offline || data?.available) && <Typography.Text type="secondary">{offline ? 'Сохранённая опись источника' : 'Последняя проверка источника'}: {data?.available?.version || (source.loading ? 'проверяем…' : 'нет проверенной версии')}{data?.available && !fresh ? ' · сохранённые данные' : ''}</Typography.Text>}
            {devSupply && <Typography.Text>Dev-поставка: {devSupply.version}</Typography.Text>}
            <Typography.Text type="secondary">Готово к установке: {installSupply?.version || 'поставка ещё не подготовлена'}</Typography.Text>
            {devSupply && data?.imported && <Typography.Text type="secondary">В каталоге подготовлено: {data.imported.version}</Typography.Text>}
            {data?.checkedAt && Number.isFinite(Date.parse(data.checkedAt)) && <Typography.Text type="secondary">Проверено: {new Date(data.checkedAt).toLocaleString('ru-RU')}</Typography.Text>}
        </div>
        <Space wrap className="bridge-source__actions">
            <Button loading={installer.loading || (source.loading && !source.checking)} disabled={source.checking || source.saving || imports.blocked} onClick={() => { installer.reload(); void source.reload(); }}>Обновить локальную поставку</Button>
            {!offline && <Button loading={source.checking} disabled={(source.loading && !source.checking) || source.saving || imports.blocked} onClick={() => { void source.check(); }}>Проверить новые версии в GitHub</Button>}
            {installerUrl && installSupply && (!devSupply || targetSupported) && <Typography.Link href={installerUrl} target="_blank" rel="noopener noreferrer">Установщик моста ({windows ? 'PowerShell' : 'macOS / Linux'})</Typography.Link>}
            {canInstall && installer.origin && <Button onClick={onInstall}>{device ? devUpdate ? 'Обновить dev-мост' : installedComparison === -1 ? 'Обновить мост' : 'Показать команду установки' : devSupply ? 'Установить dev-мост' : 'Установить мост'}</Button>}
            {canManage && fresh && !data?.importedError && status === 'available' && <Button type="primary" loading={imports.busy} disabled={sourceBusy} onClick={() => { if (data) void imports.start(data); }}>Подготовить {data?.available?.version} к установке</Button>}
        </Space>
        {devSupply && <Typography.Paragraph type="secondary">Установщик использует dev-поставку этого сервера. Каталожный источник и его импорт показаны отдельно.</Typography.Paragraph>}
        {offline && <Typography.Paragraph type="secondary">Автономная поставка. Новые версии станут доступны после загрузки обновлённой поставки на сервер. GitHub не запрашивается.</Typography.Paragraph>}
        {installer.loading && <Typography.Text type="secondary">Получаем адрес установщика…</Typography.Text>}
        {!installer.loading && !installer.origin && <Alert type="warning" showIcon message={installer.error} action={<Button onClick={installer.reload}>Повторить загрузку адреса</Button>} />}
        {(source.error || data?.error) && <Alert type="warning" showIcon message={source.error || data?.error} description={devSupply ? 'Каталожный источник недоступен. Dev-поставка установщика доступна отдельно.' : offline ? 'Загрузите обновлённую локальную поставку и перечитайте её.' : data?.imported ? 'Новая версия не подтверждена. Уже подготовленный установщик остаётся доступен.' : 'Новая версия не подтверждена. Повторите проверку; установщик станет доступен после подготовки поставки.'} />}
        {data?.importedError && <Alert type="warning" showIcon message={data.importedError} description="Не удалось подтвердить подготовленную поставку. Главному администратору нужно проверить ассет моста в каталоге." />}
        {fresh && status === 'older' && <Typography.Text type="secondary">На сервере уже подготовлена более новая версия. Понижение не предлагается.</Typography.Text>}
        {fresh && status === 'conflict' && <Alert type="warning" showIcon message="У одной версии разные комплекты" description="Источник должен опубликовать исправленную поставку под новой версией. Подмена уже подготовленного комплекта недоступна." />}
        {installSupply && !targetSupported && <Typography.Text type="warning">Для системы выбранного компьютера в этой поставке нет пакета.</Typography.Text>}
        {installedComparison !== undefined && installedComparison > 0 && <Typography.Text type="secondary">На компьютере сообщена более новая версия. Понижение не предлагается.</Typography.Text>}
        {differentBuild && !devSupply && <Typography.Text type="warning">Версия компьютера совпадает, но комплект отличается. Проверьте происхождение установленного моста перед переустановкой.</Typography.Text>}
        {!canManage && fresh && status === 'available' && <Typography.Text type="secondary">Новая версия найдена. Подготовить её к установке может главный администратор.</Typography.Text>}
        {imports.error && <Alert type="error" showIcon message={imports.error} action={canManage && imports.intent && !imports.job ? <Button loading={imports.busy} onClick={() => { void imports.repeat(); }}>Повторить сохранённый запрос</Button> : undefined} />}
        {imports.job && <div className="bridge-source__job"><Typography.Text role="status">{imports.job.message}</Typography.Text>
            {!matchesSource && <Typography.Text type="warning">Источник изменён. Этот результат относится к прежней настройке. Закройте результат и проверьте новый источник.</Typography.Text>}
            {imports.job.items.filter(item => item.state === 'FAILED' || item.action === 'conflict').map(item => <Typography.Text key={item.id} type="danger">{item.reason || item.message || item.state}</Typography.Text>)}
            {canManage && <Space wrap>{activeImport(imports.job.state) ? <Button loading={imports.busy} onClick={() => { void imports.cancel(); }}>Остановить подготовку</Button> : <>
                {matchesSource && ['FAILED', 'PARTIAL'].includes(imports.job.state) && <Button loading={imports.busy} onClick={() => { void imports.retry(); }}>Повторить подготовку</Button>}
                {replaceable && <Button onClick={() => { if (imports.job && data) setResolving({jobId: imports.job.id, digest: imports.job.planDigest, revision: data.revision}); }}>Рассмотреть замену источника</Button>}
                <Button onClick={imports.clear}>Закрыть результат</Button>
            </>}</Space>}
        </div>}
        {canManage && !offline && <Collapse ghost className="bridge-source__settings"><Collapse.Panel key="source" header="Источник версий моста">
            <Typography.Paragraph type="secondary">Публичный GitHub-репозиторий поставок в формате neurocenter-assets. Например, ваш fork. Проверка читает описания; файлы скачиваются только при подготовке выбранной версии. Ссылка на install.sh сюда не подходит.</Typography.Paragraph>
            <Input aria-label="Репозиторий версий моста" value={url} maxLength={2048} disabled={sourceBusy || !data} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/owner/neurocenter-assets" />
            <Button disabled={sourceBusy || !data || url.trim() === data.url} loading={source.saving} onClick={() => { void source.save(url).then(saved => { if (saved) void source.check(); }); }}>Сохранить и проверить</Button>
        </Collapse.Panel></Collapse>}
        <Modal open={confirming && canManage && replaceable} title="Подготовить мост из нового источника?" okText="Принять новый источник" cancelText="Оставить текущую поставку"
            confirmLoading={imports.busy} onCancel={() => { if (!imports.busy) setResolving(undefined); }}
            onOk={() => {
                const live = liveConfirmation.current;
                if (confirming && replaceable && live.canManage && live.jobId === resolving?.jobId && live.digest === resolving?.digest && live.revision === resolving?.revision)
                    void imports.resolve().then(done => { if (done) setResolving(undefined); });
            }}>
            <Typography.Paragraph>Текущая поставка: {data?.imported?.version || 'не подтверждена'}{data?.imported ? ` · ${data.imported.repositoryUrl || 'commit ' + data.imported.repositoryCommit.slice(0, 12)}` : ''}.</Typography.Paragraph>
            <Typography.Paragraph>Новый источник: {data?.url} · версия {data?.available?.version || 'не подтверждена'}.</Typography.Paragraph>
            {conflicts.map(item => <Typography.Paragraph key={item.id}>{item.name}: {item.reason || item.message}</Typography.Paragraph>)}
            <Typography.Paragraph>Подготовленная на сервере поставка будет заменена. На компьютерах обновление начнётся после явного запуска установщика.</Typography.Paragraph>
        </Modal>
    </div>;
}
