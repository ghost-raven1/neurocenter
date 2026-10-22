import { Button, Input, Space, Typography } from 'antd';
import type { FC } from 'react';
import type { IPublicationFile } from './publicationDraft';

interface IProps { files: IPublicationFile[]; onChange: (files: IPublicationFile[]) => void; disabled: boolean; }

/** Редактор текстового пакета; пустые строки не отбрасываются при отправке молча. */
export const PublicationFiles: FC<IProps> = ({files,onChange,disabled}) => <Space direction="vertical" style={{width:'100%'}}>
    <Typography.Text type="secondary">Текстовые файлы UTF-8: до 100 файлов, 1 МиБ на файл и 5 МиБ всего. Архив исходников добавляется через «Упаковать инструмент» в каталоге.</Typography.Text>
    {files.map((file,index) => <div key={index} style={{padding:12,background:'#f5f7f8',borderRadius:8}}>
        <Space style={{display:'flex',marginBottom:8}} wrap>
            <Input aria-label={`Путь файла ${index+1}`} placeholder="Например, dist/index.js" value={file.path} disabled={disabled} onChange={event=>onChange(files.map((current,i)=>i===index ? {...current,path:event.target.value} : current))} />
            <Button danger disabled={disabled} onClick={()=>onChange(files.filter((_,i)=>i!==index))}>Удалить файл {index+1}</Button>
        </Space>
        <Input.TextArea aria-label={`Содержимое файла ${index+1}`} placeholder="Текст файла" rows={5} value={file.content} disabled={disabled} style={{fontFamily:'monospace'}} onChange={event=>onChange(files.map((current,i)=>i===index ? {...current,content:event.target.value} : current))} />
    </div>)}
    <Button block type="dashed" disabled={disabled || files.length>=100} onClick={()=>onChange([...files,{path:'',content:''}])}>Добавить текстовый файл</Button>
</Space>;
