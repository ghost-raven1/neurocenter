import { useCatalogSuppliesAccess } from '../../../../features/AssetSources/hooks/useCatalogSuppliesAccess';
import { Space, Typography } from 'antd';
/** Recovery links open separately so the current files, entrypoint and build journal stay in this form. */
export function SourceReadHelp(): JSX.Element {
    const { sourcePermission } = useCatalogSuppliesAccess();
    return (
        <Space direction="vertical">
            <Typography.Text>
                Прежний выбор исходников сохранён, если он был. Выберите другой файл или повторите чтение.
            </Typography.Text>
            <Typography.Text>
                Для архива исходников: до 1 МиБ на файл и 5 МиБ всех файлов, включая пропускаемые; архив до 8 МиБ,
                распаковка до 10 МиБ. Удалите лишние файлы до упаковки, не отключая проверку.
            </Typography.Text>
            <Typography.Text>
                Для отдельной готовой программы выберите «Архив MCP» в этой форме. Архив готовых поставок с проверенной
                описью index.json импортируется отдельно.
            </Typography.Text>
            {sourcePermission ? (
                <Space wrap>
                    <Typography.Link href="/assets" target="_blank" rel="noopener noreferrer">
                        Открыть рецепты поставки
                    </Typography.Link>
                    <Typography.Link href="/assets?archive=open" target="_blank" rel="noopener noreferrer">
                        Импортировать архив поставок с описью
                    </Typography.Link>
                </Space>
            ) : (
                <Typography.Text>
                    Для рецепта или архива поставок обратитесь к главному администратору. Здесь можно повторно выбрать
                    исходники.
                </Typography.Text>
            )}
        </Space>
    );
}
