import {Alert, Button, Space} from 'antd';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import type {useAssetImports} from './useAssetImports';

/** Новый выбор доступен только после подтверждённого отказа, проверка неизвестного исхода не создаёт импорт. */
export function AssetImportRecovery({imports,onChangeSelection}:{imports:ReturnType<typeof useAssetImports>;onChangeSelection?:(ids:string[])=>void}):JSX.Element|null {
 const unresolved=!!imports.intent&&!imports.job;
 if(!imports.error&&!(unresolved&&imports.busy)){return null;}
 const changeSelection=():void=>{if(imports.canReset&&!imports.busy){onChangeSelection?.(imports.intent?.ids??[]);imports.clear();}};
 return <Alert type={imports.error?'error':'info'} showIcon message={imports.busy&&unresolved?'Ждём подтверждения импорта…':imports.error}
  description={unresolved?(imports.busy?'Выбранные ассеты сохранены. Дождитесь ответа.':imports.canReset?'Импорт не создан. Можно изменить выбор или повторить запрос.':'Результат запроса пока неизвестен. Проверьте состояние или повторите тот же запрос.'):undefined}
  action={unresolved?<Space wrap>
   {imports.canReset?<Button type="primary" disabled={imports.busy} onClick={changeSelection}>Изменить выбор</Button>:<Button disabled={imports.busy} onClick={()=>void imports.recheck()}>Проверить состояние</Button>}
   <FeatureButton features={['asset_sources']} disabled={imports.busy} onClick={()=>void imports.repeat()}>Повторить запрос</FeatureButton>
  </Space>:undefined}/>;
}
