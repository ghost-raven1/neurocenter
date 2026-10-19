import { Button, Input, Space, Typography, Upload, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { ISkillResource } from '../../../core/api/interfaces';
import { checkSkillResources, readSkillResources } from './skillResourceFiles';

interface Props { value?: ISkillResource[]; onChange?: (value: ISkillResource[]) => void; disabled?: boolean; onLoadingChange?: (value: boolean) => void; }

/** Ресурсы входят в черновик формы; ошибки чтения не сбрасывают уже добавленные файлы. */
export function SkillResources({value = [], onChange, disabled, onLoadingChange}: Props) {
    const [loading, setLoading] = useState(false);
    const reading = useRef(false);
    const active = useRef(true);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const beforeUpload = (file: File, files: File[]) => {
        if (file === files[0] && !reading.current) {
            reading.current = true; setLoading(true); onLoadingChange?.(true);
            void readSkillResources(files).then(added => {
                const next = [...value, ...added]; checkSkillResources(next); if (active.current) { onChange?.(next); }
            }).catch((error: unknown) => { if (active.current) { message.error(error instanceof Error ? error.message : 'Не удалось прочитать ресурсы.'); } })
                .finally(() => { reading.current = false; if (active.current) { setLoading(false); onLoadingChange?.(false); } });
        }
        return Upload.LIST_IGNORE;
    };
    return <Space direction="vertical" style={{width:'100%'}}>
        <Space wrap>
            <Upload multiple showUploadList={false} disabled={disabled || loading} beforeUpload={beforeUpload}><Button disabled={disabled || loading} loading={loading}>Добавить файлы</Button></Upload>
            <Upload directory multiple showUploadList={false} disabled={disabled || loading} beforeUpload={beforeUpload}><Button disabled={disabled || loading}>Добавить папку</Button></Upload>
        </Space>
        <Typography.Text type="secondary">До 99 файлов: scripts/, references/, assets/. До 1 МиБ на файл, 4 МиБ суммарно. Инструкция SKILL.md задаётся отдельно. Скрипты при загрузке не запускаются.</Typography.Text>
        {value.map((file, index) => <Space.Compact key={index} style={{width:'100%'}}>
            <Input aria-label={`Путь ресурса ${index + 1}`} value={file.path} disabled={disabled || loading}
                onChange={event => onChange?.(value.map((item, i) => i === index ? {...item,path:event.target.value} : item))} />
            <Button disabled={disabled || loading} aria-label={`Удалить ресурс ${index + 1}`} onClick={() => onChange?.(value.filter((_, i) => i !== index))}>Удалить</Button>
        </Space.Compact>)}
        {value.length > 0 && <Typography.Text type="secondary">Ресурсов: {value.length}. Изменение состава создаёт новую версию скилла.</Typography.Text>}
    </Space>;
}
