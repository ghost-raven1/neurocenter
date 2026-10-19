import { Alert, Button } from 'antd';
import { useHistory } from 'react-router-dom';
import type { useBridge } from './useBridge';
import { connectionBlocker } from './readiness';
import { projectBindingUrl } from '../../modules/Projects/projectNavigation';

/** Показывает ближайший шаг подготовки выбранного проекта; индивидуальный пакет проверяется отдельно. */
export function ProjectInstallationReadiness({bridge,projectId,canInstall}: {
    bridge:ReturnType<typeof useBridge>; projectId:string; canInstall:boolean;
}) {
    const history = useHistory();
    if (!bridge.device || !bridge.devicesReady) { return null; }
    const blocker = connectionBlocker(bridge.device);
    // BridgeConnection уже показывает общий шаг подготовки компьютера.
    if (blocker && canInstall) { return null; }
    const binding = bridge.device.report.bindings?.find(value => value.projectId === projectId && value.valid !== false && value.bindingId);
    const state = !canInstall ? {message:'Для установки нужна роль разработчика в выбранном проекте. Попросите администратора проекта предоставить доступ.',route:''}
        : !binding ? {message:'Выберите папку этого проекта на компьютере. После привязки одобренный инструмент устанавливается одним нажатием.',route:projectBindingUrl(projectId)}
        : !bridge.jobsReady || !bridge.installationsReady ? {message:'Дождитесь загрузки очереди и текущих установок. При ошибке нажмите «Обновить данные».',route:''}
        : !bridge.device.online ? {message:'Компьютер не в сети. Установку можно поставить в очередь; настройка и диагностика станут доступны после подключения моста.',route:''}
        : {message:'Компьютер и папка готовы. Выберите инструмент: одобренный комплект установится одним нажатием. Настройка и проверка запуска появятся в блоке «На этом компьютере».',route:''};
    return <Alert className="bridge-connection__project-readiness" style={{marginTop:12}} type="info" showIcon message={state.message}
        action={state.route ? <Button onClick={() => history.push(state.route)}>Выбрать папку проекта</Button> : undefined} />;
}
