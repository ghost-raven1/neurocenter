import { CopyOutlined } from '@ant-design/icons';
import { Button, Collapse, Empty, Typography } from 'antd';
import type { IAiPlugin } from '../../core/api/interfaces';
import { RuntimeArtifactsDetails } from './installPlans/RuntimeArtifactsDetails';
import { hasConfigSecrets, previewConfig } from './storeDetails';

interface IProps {
    plugin: IAiPlugin;
    copying: boolean;
    onCopy: (value: string) => void;
}

/** Сначала объясняет доставку через мост; исходные настройки остаются в дополнительных сведениях. */
export function StoreBundleContent({ plugin, copying, onCopy }: IProps) {
    const config = previewConfig(plugin.config);
    return <section aria-label="Содержимое инструмента">
        <RuntimeArtifactsDetails config={plugin.config ? { ...plugin.config } : null} compact />
        {config && <Collapse className="store-details__configuration">
            <Collapse.Panel key="configuration" header="Дополнительно: конфигурация подключения">
                <div className="store-details__toolbar">
                    <Typography.Text type="secondary">Пример настройки. Для установки используйте мост.</Typography.Text>
                    <Button size="small" icon={<CopyOutlined />} loading={copying} onClick={() => onCopy(config)}>{hasConfigSecrets(plugin.config) ? 'Копировать пример' : 'Копировать конфигурацию'}</Button>
                </div>
                <pre className="store-details__source" tabIndex={0} aria-label="Конфигурация JSON">{config}</pre>
                {hasConfigSecrets(plugin.config) && <Typography.Paragraph type="secondary">Значения переменных окружения и заголовков скрыты. Персональные параметры вводятся локально.</Typography.Paragraph>}
            </Collapse.Panel>
        </Collapse>}
        {plugin.files.length > 0 ? <>
            <Typography.Paragraph strong>Файлы пакета · {plugin.files.length}</Typography.Paragraph>
            <Collapse>
                {plugin.files.map((file, index) => <Collapse.Panel key={`${index}:${file.path}`} header={<span className="store-details__file-name">{file.path}</span>}>
                    {typeof file.content === 'string'
                        ? <pre className="store-details__source" tabIndex={0} aria-label={`Содержимое ${file.path}`}>{file.content || '(пустой файл)'}</pre>
                        : <Typography.Text type="secondary">Содержимое файла не передано сервером.</Typography.Text>}
                </Collapse.Panel>)}
            </Collapse>
        </> : !config && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Файлы и конфигурация не опубликованы" />}
    </section>;
}
