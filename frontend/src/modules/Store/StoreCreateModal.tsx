import { FeatureButton, useFeatureAvailability } from '../../features/FeatureFlags/FeatureAvailability';
import { Alert, Button, Checkbox, Form, Input, Modal, Radio, Select, Space, Typography, message } from 'antd';
import { FC, useRef, useState } from 'react';
import bffApi from '../../core/api/bff';
import { errorMessage } from '../../common/utils/errorMessage';
import type { IAiPluginCreate, ISkillCreateRequest } from '../../core/api/interfaces';
import { SkillResources } from '../../features/Catalog/publication/SkillResourceEditor';
import { checkSkillResources } from '../../features/Catalog/publication/skillResourceFiles';
import { PublicationFiles } from '../../features/Catalog/publication/PublicationFiles';
import { checkPublicationMcpField, newPublicationKey, publicationPayload } from '../../features/Catalog/publication/publicationDraft';
import type { IPublicationDraft, IPublicationFile, TPublicationMcpField } from '../../features/Catalog/publication/publicationDraft';
import { DependencyPinsEditor } from '../../features/Catalog/publication/DependencyPinsEditor';
import { checkDependencyPins } from '../../features/Catalog/publication/dependencyPins';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { notifySkillMutation } from '../../features/Catalog/skillMutationFeedback';
import type { ISkillMutationReceipt } from '../../core/api/interfaces';

interface IProps { open: boolean; onClose: () => void; onCreated: () => void; onPackage: (source?: 'files') => void; }

const mcpFieldRule = (field: TPublicationMcpField) => ({validator: (_: unknown, value: string | undefined) => {
    try { checkPublicationMcpField(field, value); return Promise.resolve(); } catch (cause) { return Promise.reject(cause); }
}});

/** Публикация карточки с явными требованиями к каждому поддерживаемому типу инструмента. */
const StoreCreateModal: FC<IProps> = ({open,onClose,onCreated,onPackage}) => {
    const { captureOwner } = useAuthRequestOwner();
    const [form] = Form.useForm<IPublicationDraft>();
    const kind = Form.useWatch('kind',form) ?? 'mcp';
    const mode = Form.useWatch('mode',form) ?? 'remote';
    const [files,setFiles] = useState<IPublicationFile[]>([]);
    const [busy,setBusy] = useState(false);
    const [resourcesBusy,setResourcesBusy] = useState(false);
    const [dependenciesBusy,setDependenciesBusy] = useState(false);
    const [error,setError] = useState('');
    const submitting = useRef(false);
    const request = useRef<{signature:string;key:string}>();
    const bundled = kind === 'plugin' || kind === 'mcp' && mode === 'bundle';
    const reading = resourcesBusy || dependenciesBusy;

    /** Правка пакета отзывает старую ошибку и исчезнувшую точку входа, сохраняя остальные поля. */
    const changeFiles = (next: IPublicationFile[]): void => {
        setFiles(next); setError('');
        const entrypoint = form.getFieldValue('entrypoint');
        if (entrypoint && !next.some(file => file.path === entrypoint)) { form.setFieldsValue({entrypoint: undefined}); }
    };

    const availability = useFeatureAvailability('tool_catalog');
    const submit = async (values: IPublicationDraft): Promise<void> => {
        if (!availability.enabled) return;
        if (submitting.current || reading) { return; }
        const isCurrent = captureOwner();
        if (!isCurrent()) { return; }
        setError('');
        try {
            if (values.kind === 'skill') { checkSkillResources(values.resources ?? []); }
            const payload = publicationPayload(values,files);
            submitting.current=true; setBusy(true);
            let skillResult: ISkillMutationReceipt | undefined;
            if (values.kind === 'skill') { skillResult = await bffApi.createSkill(payload as ISkillCreateRequest); }
            else {
                const signature=JSON.stringify(payload);
                if (request.current?.signature!==signature) { request.current={signature,key:newPublicationKey()}; }
                await bffApi.createAiPlugin({...payload,publicationKey:request.current.key} as IAiPluginCreate);
            }
            if (!isCurrent()) { return; }
            if (skillResult) { notifySkillMutation(skillResult, 'Инструмент добавлен в общий магазин'); }
            else { message.success('Инструмент добавлен в общий магазин'); }
            form.resetFields(); setFiles([]); request.current=undefined;
            onClose(); onCreated();
        } catch (cause) { if (isCurrent()) { setError(errorMessage(cause,'Не удалось опубликовать. Введённые данные сохранены — повторите попытку.')); } }
        finally { submitting.current=false; if (isCurrent()) { setBusy(false); } }
    };

    return <Modal open={open} title="Добавить в общий магазин" width={760} style={{top:24}} footer={null}
        onCancel={()=>{if(!submitting.current && !reading){onClose();}}} closable={!busy && !reading} maskClosable={!busy && !reading} keyboard={!busy && !reading}>
        <Form name="store-create" form={form} layout="vertical" scrollToFirstError={{block:'center'}} disabled={busy || reading} initialValues={{kind:'mcp',mode:'remote'}} onValuesChange={()=>setError('')} onFinish={values=>{void submit(values);}}>
            <Form.Item name="kind" label="Что добавляем"><Radio.Group options={[{value:'mcp',label:'MCP'},{value:'plugin',label:'Плагин'},{value:'skill',label:'Скилл'}]} /></Form.Item>
            <Alert type="info" showIcon message={kind==='skill'?'Готовый скилл можно добавить архивом. Найдём SKILL.md и сохраним его ресурсы.':'npm, GitHub или архив добавляются через упаковку'}
                action={<Button disabled={busy || reading} onClick={()=>{if(!submitting.current && !reading){onPackage(kind==='skill'?'files':undefined);}}}>{kind==='skill'?'Добавить скилл архивом':'Упаковать инструмент'}</Button>} />
            <Form.Item name="name" label="Название" rules={[{required:true,whitespace:true,message:'Введите название'},{max:128,message:'До 128 символов'}]} extra="Можно по-русски. Название не обязано совпадать с именем папки."><Input placeholder="Например, Проверка кода" /></Form.Item>
            <Form.Item name="description" label="Описание" rules={[{required:true,whitespace:true,message:'Расскажите, для чего нужен инструмент'},{max:kind==='skill'?1024:2000,message:'Описание слишком длинное'}]}><Input.TextArea rows={2} placeholder="Что делает инструмент и когда его использовать" /></Form.Item>
            <Form.Item name="tags" label="Теги" extra="До 20 тегов через запятую"><Input placeholder="Например, код, проверка" /></Form.Item>
            {kind==='skill' && <>
                <Form.Item name="slug" label="Идентификатор скилла" rules={[{required:true,message:'Укажите идентификатор'}]} extra="Латиница, цифры и дефисы; например, rag-index-monitor. Имя каталога SKILL.md останется стабильным."><Input placeholder="rag-index-monitor" /></Form.Item>
                <Form.Item name="instruction" label="Инструкция скилла" rules={[{required:true,whitespace:true,message:'Добавьте инструкцию'}]} extra="Markdown без YAML-шапки: она формируется из полей выше. Ресурсы добавьте ниже; они сохранятся вместе с инструкцией."><Input.TextArea rows={10} placeholder="Шаги, правила и примеры для помощника…" /></Form.Item>
                <Form.Item name="resources" label="Ресурсы скилла"><SkillResources disabled={busy || dependenciesBusy} onLoadingChange={setResourcesBusy} /></Form.Item>
            </>}
            {kind==='mcp' && <>
                <Form.Item name="mode" label="Как запускается MCP"><Select options={[{value:'remote',label:'Удалённый сервер по URL'},{value:'bundle',label:'Текстовый пакет Node.js'}]} /></Form.Item>
                {mode==='remote' ? <>
                    <Form.Item name="url" label="Адрес MCP" required rules={[mcpFieldRule('url')]}><Input placeholder="https://example.org/mcp" /></Form.Item>
                    <Form.Item name="headers" label="Заголовки (JSON)" rules={[mcpFieldRule('headers')]} extra='Личные ключи — только через окружение: {"Authorization":"Bearer {env:MCP_TOKEN}"}'><Input.TextArea rows={3} placeholder='{"Authorization":"Bearer {env:MCP_TOKEN}"}' /></Form.Item>
                    <Form.Item name="disableOAuth" valuePropName="checked"><Checkbox>Отключить автоматический OAuth</Checkbox></Form.Item>
                    <Alert type="info" showIcon message="Публикация сохраняет подключение. Доступность сервера и вход каждый пользователь проверяет локально в OpenCode." />
                </> : <>
                    <Form.Item name="args" label="Аргументы (JSON-массив)" rules={[mcpFieldRule('args')]} extra='Каждый аргумент — отдельная строка. Пробелы сохраняются: ["--label", "Мой проект"]'><Input.TextArea rows={3} placeholder='["--port", "3000"]' /></Form.Item>
                    <Form.Item name="env" label="Окружение (JSON)" rules={[mcpFieldRule('env')]} extra='Секреты заменяйте ссылками {env:ИМЯ_ПЕРЕМЕННОЙ}; они не должны храниться в общем магазине.'><Input.TextArea rows={3} placeholder='{"API_KEY":"{env:API_KEY}"}' /></Form.Item>
                </>}
            </>}
            {bundled && <>
                <Form.Item label="Файлы пакета"><PublicationFiles files={files} onChange={changeFiles} disabled={busy || reading} /></Form.Item>
                <Form.Item name="entrypoint" label="Файл запуска" rules={[{required:true,message:'Укажите файл запуска из пакета'}]}><Select placeholder="Сначала добавьте файлы" options={files.filter(file=>file.path).map(file=>({value:file.path,label:file.path}))} /></Form.Item>
                <Alert type="info" showIcon message={kind==='mcp'?'Нужен подготовленный JS-пакет. Node.js и зависимости не устанавливаются этой формой автоматически.':'Нужны готовые файлы плагина. Сборка исходников и загрузка npm-зависимостей этой формой не выполняются.'} />
            </>}
            <Form.Item name="dependencies" label="Закреплённые зависимости" rules={[{validator: (_, value: unknown) => {
                try { checkDependencyPins(value ?? []); return Promise.resolve(); } catch (cause) { return Promise.reject(cause); }
            }}]}><DependencyPinsEditor disabled={busy || resourcesBusy} onLoadingChange={setDependenciesBusy} /></Form.Item>
            {error && <Alert role="alert" type="error" showIcon message={error} style={{marginTop:16}} />}
            <Typography.Paragraph type="secondary" style={{marginTop:16}}>Заполненная форма остаётся в этой вкладке при закрытии и ошибке. Новую версию существующего инструмента создавайте через «Редактировать».</Typography.Paragraph>
            <Space wrap style={{display:'flex',justifyContent:'flex-end'}}><Button disabled={busy || reading} onClick={onClose}>Закрыть</Button><FeatureButton features={['tool_catalog']} type="primary" htmlType="submit" loading={busy} disabled={reading}>Добавить в магазин</FeatureButton></Space>
        </Form>
    </Modal>;
};
export default StoreCreateModal;
