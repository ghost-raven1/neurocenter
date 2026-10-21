import type { ResolvedAsset } from '@neurocenter/asset-contract';
import type { Pool } from 'pg';
import type { ISourceReceipt } from './import-types';
import { SkillAssetClient } from './skill-adapter';

interface ICardState { archived:boolean; unavailable:boolean;name?:string }
/** Ошибка одной native-карточки не скрывает остальные сохранённые ассеты. */
export async function assetCardState(pool:Pool,receipt:ISourceReceipt):Promise<ICardState> {
    try {
        const row=receipt.asset_kind==='agent'?(await pool.query('SELECT name,archived_at FROM agent_catalog WHERE id=$1',[receipt.native_id])).rows[0]
            :receipt.asset_kind==='model'?(await pool.query('SELECT name,archived_at FROM model_catalog WHERE id=$1',[receipt.native_id])).rows[0]
            :receipt.asset_kind==='skill'?await new SkillAssetClient().inspect(receipt.native_id)
            :['mcp','plugin'].includes(receipt.asset_kind)?(await pool.query('SELECT name,archived_at FROM ai_plugins WHERE id=$1',[receipt.native_id])).rows[0]:{};
        return {archived:!!(row?.archived_at??row?.archivedAt),unavailable:!row,...(typeof row?.name==='string'?{name:row.name}:{})};
    }catch{return {archived:false,unavailable:true};}
}

/** Общая публичная карточка не раскрывает исходники, локальные пути и адреса доставки. */
export function sourceAssetView(asset:ResolvedAsset['asset'],sha256:string,receipt?:ISourceReceipt,state?:ICardState) {
    const card=asset.card;
    return {id:asset.id,kind:asset.kind,version:asset.version,sha256,name:card.name,
        description:'description'in card?card.description:asset.kind==='skill'?asset.card.meta.description:asset.kind==='model'?asset.card.descriptor.description:asset.kind==='agent'?asset.card.definition.description:undefined,
        license:asset.license.spdx,dependencies:(asset.dependencies??[]).map(({id,version})=>({id,version})),
        imported:receipt?{id:receipt.native_id,version:receipt.native_version,originVersion:receipt.asset_version,
            updateAvailable:receipt.descriptor_sha256!==sha256,...state}:undefined};
}
