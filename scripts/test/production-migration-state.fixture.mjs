import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const identifier=value=>'"'+value.replaceAll('"','""')+'"';
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const tablesSql=`SELECT coalesce(json_object_agg(c.relname,json_build_object(
 'columns',(SELECT json_agg(a.attname ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'primaryKey',coalesce((SELECT json_agg(a.attname ORDER BY k.position) FROM pg_constraint p
 CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(number,position)
 JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.number WHERE p.conrelid=c.oid AND p.contype='p'),'[]'::json)
)),'{}'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')`;

async function rowHashes(query,table,columns,primaryKey){
    if(table==='bridge_pairs')return [];
    const projection=`(SELECT jsonb_object_agg(column_name,to_jsonb(t)->column_name)
        FROM unnest(ARRAY[${columns.map(literal).join(',')}]::text[]) names(column_name))`;
    const key=primaryKey.length?`jsonb_build_array(${primaryKey.map(name=>'t.'+identifier(name)).join(',')})`:'NULL';
    const rows=JSON.parse(await query(`SELECT coalesce(json_agg(json_build_object('key',${key},'value',${projection}::text)),'[]'::json) FROM ${identifier(table)} t`));
    return rows.map(row=>({key:row.key===null?null:sha(JSON.stringify(row.key)),value:sha(row.value)}))
        .sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/** Capture every source column and row; values stay hashed in the private acceptance report. */
export async function captureMigrationState(query){
    const tables=JSON.parse(await query(tablesSql));
    for(const [table,metadata] of Object.entries(tables)){
        if(table==='bridge_devices')metadata.columns=metadata.columns.filter(name=>name!=='last_seen');
        metadata.rows=await rowHashes(query,table,metadata.columns,metadata.primaryKey);
    }
    let legacyReceipts;
    if(tables.builtin_catalog_receipts){
        const rows=JSON.parse(await query("SELECT coalesce(json_agg(json_build_object('oldKey',r.tool_key,'nativeId',r.asset_id,'evidence',to_jsonb(r)::text) ORDER BY r.tool_key),'[]'::json) FROM builtin_catalog_receipts r"));
        legacyReceipts=rows.map(({evidence,...row})=>({...row,evidenceSha256:sha(evidence)}));
    }
    return {tables,...(legacyReceipts?{legacyReceipts}:{})};
}

/** The removed receipt table must have an exact one-to-one evidence replacement. */
async function assertReceiptReplacement(query,expected){
    const keys=expected.map(row=>literal(row.oldKey));
    const actual=JSON.parse(await query(`SELECT coalesce(json_agg(json_build_object('oldKey',old_key,'nativeId',native_id,'provenance',provenance,'evidence',evidence::text) ORDER BY old_key),'[]'::json)
        FROM asset_native_migrations WHERE migration='catalog-source-v1' AND old_key=ANY(ARRAY[${keys.join(',')}]::text[])`));
    assert.deepEqual(actual.map(({evidence,...row})=>({...row,evidenceSha256:sha(evidence)})),expected.map(row=>({...row,provenance:'local-unattributed'})),'Legacy receipt evidence replacement differs');
}

/** Added columns/rows are allowed; every old business row, historical checksum and timestamp must survive. */
export async function assertMigrationStatePreserved(query,before,{requireReceiptMigration=false}={}){
    const tables=JSON.parse(await query(tablesSql));
    for(const [table,metadata] of Object.entries(before.tables)){
        if(table==='builtin_catalog_receipts'&&!tables[table]){
            assert.ok(before.legacyReceipts,'Missing legacy receipt evidence');await assertReceiptReplacement(query,before.legacyReceipts);continue;
        }
        assert.ok(tables[table],'Missing source table: '+table);
        for(const column of metadata.columns)assert.ok(tables[table].columns.includes(column),'Missing source column: '+table+'.'+column);
        const rows=await rowHashes(query,table,metadata.columns,metadata.primaryKey);
        const counts=new Map(),keys=new Map();
        for(const row of rows){const identity=JSON.stringify(row);counts.set(identity,(counts.get(identity)||0)+1);if(row.key!==null)keys.set(row.key,(keys.get(row.key)||0)+1);}
        for(const row of metadata.rows){
            const identity=JSON.stringify(row),remaining=counts.get(identity)||0;
            assert.ok(remaining>0,'Missing or changed source row: '+table);counts.set(identity,remaining-1);
            if(row.key!==null)assert.equal(keys.get(row.key),1,'Ambiguous source primary key: '+table);
        }
    }
    if(requireReceiptMigration&&before.legacyReceipts)assert.ok(!tables.builtin_catalog_receipts,'Legacy receipt table was not retired');
}
