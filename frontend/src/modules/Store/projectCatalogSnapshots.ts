import type { IAiPlugin, IProjectAsset, ISkillFile } from '../../core/api/interfaces';
import type { IStoreApp } from '../../features/Catalog/types';
import { fromPlugin, fromSkill } from '../../features/Catalog/catalogCards';

/** В выбранном проекте pinned snapshot заменяет общий head, включая архивные карточки. */
export function mergeProjectCatalog(common:readonly IStoreApp[],assets:readonly IProjectAsset[]):IStoreApp[]{
    const result=new Map(common.map(app=>[app.kind+':'+app.id,app]));
    for(const ref of assets){
        const key=ref.assetKind+':'+ref.assetId;
        if(ref.card&&ref.version&&ref.manifest&&!ref.pinError){
            const app=ref.assetKind==='skill'?fromSkill(ref.card as ISkillFile):fromPlugin(ref.card as IAiPlugin);
            result.set(key,{...app,projectManifest:ref.manifest,projectCard:ref.assetKind==='skill'?{kind:'skill',skill:ref.card as ISkillFile}:{kind:'bundle',plugin:ref.card as IAiPlugin}});
        }else{
            const app=result.get(key);
            if(app)result.set(key,{...app,pinError:ref.pinError??'Версия назначения не подтверждена. Админ проекта должен закрепить проверенную версию.'});
        }
    }
    return [...result.values()];
}
