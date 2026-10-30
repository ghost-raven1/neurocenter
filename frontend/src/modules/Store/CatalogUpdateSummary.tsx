import { Alert, Checkbox, Space, Typography } from 'antd';

interface IProps {
    catalogCount: number;
    computerCount: number;
    sourceCount?:number;
    incomplete: boolean;
    onlyUpdates: boolean;
    onChange(value: boolean): void;
}

/** Предложения только раскрывают существующие действия одобрения и установки. */
export function CatalogUpdateSummary({catalogCount, computerCount, sourceCount=0, incomplete, onlyUpdates, onChange}: IProps): JSX.Element {
    return <Alert type="info" showIcon style={{marginBottom: 12}}
        message="Обновления проекта" description={<Space wrap>
            <Typography.Text>{catalogCount || computerCount || sourceCount
                ? `${catalogCount||computerCount?`Новые редакции в каталоге: ${catalogCount}. Отличаются версии на компьютере: ${computerCount}.`:''}${sourceCount?` Новые исходники: ${sourceCount}. Пакеты ещё не опубликованы.`:''}`
                : incomplete ? 'Не все версии подтверждены. Проверьте загрузку каталога и выбранный компьютер.' : 'Новых редакций в доступном каталоге нет. Квитанции компьютера показаны на карточках.'}</Typography.Text>
            {incomplete && !!(catalogCount || computerCount || sourceCount) && <Typography.Text type="secondary">Часть версий ещё не подтверждена.</Typography.Text>}
            <Checkbox checked={onlyUpdates} onChange={event => onChange(event.target.checked)}>Только обновления</Checkbox>
            <Typography.Text type="secondary">Ожидание и ошибки остаются видимыми.</Typography.Text>
        </Space>} />;
}
