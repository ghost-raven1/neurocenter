import {Alert,Button,Space,Typography} from 'antd';
import type {usePackagingPublication} from './usePackagingPublication';

/** Явное подтверждение обновления общего head, без изменения закреплённых установок. */
export function PackagingPublicationPanel({publication,disabled,onConfirm}:{publication:ReturnType<typeof usePackagingPublication>;disabled:boolean;onConfirm:()=>void}){
    if(!publication.target)return null;
    const {preview,selection}=publication;
    return <Alert type={publication.error||preview&&!preview.updateSupported?'warning':'info'} showIcon
        message={selection?`Новая версия «${selection.name}»`:'Проверьте цель новой версии'}
        description={<Space direction="vertical">
            {publication.loading?<Typography.Text>Проверяем текущую редакцию каталога…</Typography.Text>:<>
                {publication.error&&<Typography.Text role="alert">{publication.error}</Typography.Text>}
                {selection?<Typography.Text>На основе редакции {selection.expectedVersion}. Версии в проектах и на компьютерах сохранятся.</Typography.Text>:preview&&<Typography.Text>В каталоге редакция {preview.expectedVersion}. Предыдущая редакция и её исходники сохранятся.</Typography.Text>}
                {preview&&!preview.updateSupported&&<Typography.Text>{preview.unsupportedReason||'Обновление этого типа через упаковщик пока недоступно. Используйте редактирование карточки.'}</Typography.Text>}
                {!selection&&preview?.updateSupported&&<><Typography.Text>Подтвердите инструмент, затем выберите новый источник. Уже выбранный источник останется в форме.</Typography.Text><Button type="primary" disabled={disabled} onClick={onConfirm}>Подготовить новую версию</Button></>}
                {!selection&&preview&&!preview.updateSupported&&<Button disabled>Подготовить новую версию</Button>}
            </>}
            <Space wrap><Button size={selection?"small":"middle"} disabled={disabled||publication.loading} onClick={publication.refresh}>Обновить цель</Button><Button size={selection?"small":"middle"} type={selection?"link":"default"} disabled={disabled} onClick={publication.clear}>Упаковать отдельный инструмент</Button></Space>
            {!selection&&<Typography.Text type="secondary">Обновление цели требует нового подтверждения. Публикация начнётся только кнопкой внизу.</Typography.Text>}
        </Space>}/>;
}
