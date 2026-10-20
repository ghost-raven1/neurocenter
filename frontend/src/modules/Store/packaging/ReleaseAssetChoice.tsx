import { Form, Select, Typography } from 'antd';
import type { RepositoryMetadata, RepositoryRelease } from './types';

/** The user's choice selects an API-confirmed asset, never an arbitrary download URL. */
export function ReleaseAssetChoice({ metadata, onChange, disabled = false }: {
    metadata: RepositoryMetadata; onChange: (release: RepositoryRelease) => void; disabled?: boolean;
}) {
    if (!metadata.release || !metadata.releaseChoices?.length) return null;
    return <Form.Item label="Готовая поставка релиза" extra="Проверим содержимое архива и определим совместимые платформы по исполняемому файлу.">
        <Select aria-label="Файл релиза GitHub" value={metadata.release.asset} disabled={disabled} showSearch
            placeholder="Выберите файл релиза" options={metadata.releaseChoices.map(asset => ({
                value: asset.name, label: `${asset.name} · ${(asset.bytes / 1024 / 1024).toFixed(1)} МБ`,
            }))} onChange={asset => onChange({ tag: metadata.release!.tag, id: metadata.release!.id, asset })} />
        {metadata.release.sha256 && <Typography.Text type="secondary" title={metadata.release.sha256}>SHA-256: {metadata.release.sha256.slice(0, 16)}…</Typography.Text>}
    </Form.Item>;
}
