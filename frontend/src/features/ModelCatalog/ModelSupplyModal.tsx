import { useState } from 'react';
import { Alert, Button, Modal, Space, Typography, message } from 'antd';
import { downloadModelSupplyRecipe, modelSupplyCommand, modelSupplyFilename } from './modelSupply';
import type { ICatalogModel } from './types';

/** Оператор получает рецепт для общей поставки; секреты GitHub в браузер не передаются. */
export function ModelSupplyModal({ model, onClose }: { model: ICatalogModel; onClose: () => void }): JSX.Element {
    const [date] = useState(() => new Date());
    const download = (): void => {
        try { downloadModelSupplyRecipe(model); }
        catch { message.error('Не удалось скачать параметры поставки. Повторите попытку.'); }
    };
    return <Modal open title="Включить модель в поставку" width={680} onCancel={onClose} footer={<Space wrap>
        <Button onClick={onClose}>Закрыть</Button><Button type="primary" onClick={download}>Скачать параметры</Button>
    </Space>}>
        <Typography.Paragraph>После публикации модель будет загружаться на другие серверы вместе с поставкой проекта.</Typography.Paragraph>
        <ol>
            <li>Дождитесь загрузки весов модели на сервере.</li>
            <li>Сохраните файл <Typography.Text code>{modelSupplyFilename(model)}</Typography.Text> в корне исходников Нейроцентра на этом сервере.</li>
            <li>Выполните команду публикации из этого каталога:</li>
        </ol>
        <Typography.Paragraph copyable={{ text: modelSupplyCommand(model, date) }}>
            <Typography.Text code className="model-catalog__code">{modelSupplyCommand(model, date)}</Typography.Text>
        </Typography.Paragraph>
        <Typography.Paragraph>Команда проверит локальные веса, опубликует полный комплект в GitHub и обновит опись. Сохраните изменения описи одним коммитом и отправьте его в Git.</Typography.Paragraph>
        <Alert showIcon type="info" message="Публикация выполняется оператором"
            description="На сервере нужен gh с доступом к репозиторию. Скачивание параметров не публикует веса и не меняет хостинг. Для весов в Docker-томе сначала используйте процедуру экспорта тома." />
    </Modal>;
}
