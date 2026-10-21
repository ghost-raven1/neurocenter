import { Button, Input, Space, Typography, Upload, message } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { FileDropZone } from '../../../common/components/FileDropZone/FileDropZone';
import type { ISkillResource } from '../../../core/api/interfaces';
import { checkSkillResources, readSkillResources } from './skillResourceFiles';

interface Props { value?: ISkillResource[]; onChange?: (value: ISkillResource[]) => void; disabled?: boolean; onLoadingChange?: (value: boolean) => void; }

/** Ресурсы входят в черновик формы; ошибки чтения не сбрасывают уже добавленные файлы. */
export function SkillResources({value = [], onChange, disabled, onLoadingChange}: Props) {
    const [loading, setLoading] = useState(false);
    const reading = useRef(false);
    const active = useRef(true);
    const current = useRef({value, onChange, disabled, onLoadingChange});
    current.current = {value, onChange, disabled, onLoadingChange};
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const selectFiles = (files: File[]): void => {
        if (!active.current || current.current.disabled || reading.current || !files.length) { return; }
        reading.current = true; setLoading(true); current.current.onLoadingChange?.(true);
        void readSkillResources(files).then(added => {
            if (!active.current || current.current.disabled) { return; }
            const next = [...current.current.value, ...added]; checkSkillResources(next); current.current.onChange?.(next);
        }).catch((error: unknown) => { if (active.current && !current.current.disabled) { message.error(error instanceof Error ? error.message : 'Не удалось прочитать ресурсы.'); } })
            .finally(() => { reading.current = false; if (active.current) { setLoading(false); current.current.onLoadingChange?.(false); } });
    };
    const beforeUpload = (file: File, files: File[]) => {
        if (file === files[0]) { selectFiles(files); }
        return Upload.LIST_IGNORE;
    };
    return <Space direction="vertical" style={{width:'100%'}}>
        <FileDropZone label="Файлы ресурсов скилла" title="Перетащите ресурсы скилла сюда" buttonText="Добавить файлы"
            hint="Можно выбрать несколько файлов. Чтобы сохранить структуру папки, используйте «Добавить папку»."
            multiple disabled={disabled || loading} busy={loading} onFiles={selectFiles}
            onReject={reason => { if (active.current && !current.current.disabled && !reading.current) { message.error(reason); } }}/>
        <Space wrap>
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
