import {Alert, Button, Card, Space, Tag, Typography} from 'antd';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';
import {baseApi} from '../../core/api';
import {errorMessage} from '../../common/utils/errorMessage';
import {useAuthRequestOwner} from '../../features/UserBlock/useAuthRequestOwner';
import type {ISourceList} from '../../features/AssetSources/types';

/** Display the authoritative asset pin; replacing supply stays in the existing archive/import flow. */
export function AssetSourceSettings(): JSX.Element {
    const {captureOwner} = useAuthRequestOwner();
    const [source, setSource] = useState<ISourceList['source']>();
    const [loading, setLoading] = useState(false), [error, setError] = useState('');
    const request = useRef<AbortController>();
    const reload = useCallback(async () => {
        const owns = captureOwner();
        if (!owns() || request.current) return;
        const controller = new AbortController(); request.current = controller;
        const current = () => owns() && request.current === controller && !controller.signal.aborted;
        setLoading(true); setError('');
        try {
            const response = await baseApi.get<ISourceList>('/api/asset-sources', {signal: controller.signal, timeout: 10000});
            if (current()) setSource(response.data.source);
        } catch (cause) {
            if (current()) setError(errorMessage(cause, 'Не удалось прочитать источник ассетов. Повторите загрузку.'));
        } finally {
            if (request.current === controller) { if (current()) setLoading(false); request.current = undefined; }
        }
    }, [captureOwner]);
    useEffect(() => { void reload(); return () => { request.current?.abort(); request.current = undefined; }; }, [reload]);
    return <Card title="Поставка ассетов" className="settings-page__source" extra={<Button loading={loading} onClick={() => { void reload(); }}>Обновить сведения</Button>}>
        <Space direction="vertical" size="middle" className="settings-page__content">
            {error && <Alert type="warning" showIcon message={error} description={source ? 'Показан последний прочитанный источник.' : undefined}/>}
            {source && <><Space wrap><Tag>{source.mode === 'offline' ? 'Автономная поставка' : 'Сетевая поставка'}</Tag><Typography.Text className="settings-page__url">{source.repository}</Typography.Text></Space>
                <Typography.Text type="secondary" className="settings-page__url">{source.archiveSha256 ? 'Загружен архив · SHA-256 ' + source.archiveSha256 : source.commit ? 'Закреплённый commit · ' + source.commit : 'Проверенная опись ещё не загружена'}</Typography.Text>
                {source.error && <Alert type="warning" showIcon message={source.error}/>}
            </>}
            <Typography.Paragraph type="secondary">Адрес и точная версия общей поставки задаются при развёртывании сервера. Загрузить архив, выбрать карточки и проверить источник можно в разделе <Link to="/assets">«Ассеты»</Link>.</Typography.Paragraph>
        </Space>
    </Card>;
}
