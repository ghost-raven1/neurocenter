const local=(value:string)=>`replace(replace(${value},quote_ident(current_schema())||'.',''),current_schema()||'.','')`;

/** Read-only facts are independent of role names, database names and the current schema name. */
export const CATALOG_SCHEMA_FACTS_SQL=`
WITH relations AS (
 SELECT c.* FROM pg_class c WHERE c.relnamespace=to_regnamespace(current_schema()) AND c.relkind IN ('r','p','v','m','f')
)
SELECT 'table'::text AS kind,r.relname::text AS id,jsonb_build_object('kind',r.relkind,'persistence',r.relpersistence) AS definition FROM relations r
UNION ALL
SELECT 'column',r.relname||'.'||a.attname,jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
 'default',${local('pg_get_expr(d.adbin,d.adrelid)')})
 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
UNION ALL
SELECT 'constraint',r.relname||'.'||c.conname,jsonb_build_object('type',c.contype,'definition',${local('pg_get_constraintdef(c.oid,true)')},'validated',c.convalidated)
 FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
UNION ALL
SELECT 'index',i.relname,jsonb_build_object('definition',${local('pg_get_indexdef(i.oid)')},'valid',x.indisvalid,'ready',x.indisready)
 FROM relations r JOIN pg_index x ON x.indrelid=r.oid JOIN pg_class i ON i.oid=x.indexrelid
UNION ALL
SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('definitionMd5',md5(${local('pg_get_functiondef(p.oid)')}))
 FROM pg_proc p WHERE p.pronamespace=to_regnamespace(current_schema()) AND p.prokind='f'
UNION ALL
SELECT 'trigger',r.relname||'.'||t.tgname,jsonb_build_object('definition',${local('pg_get_triggerdef(t.oid,true)')},'enabled',t.tgenabled)
 FROM relations r JOIN pg_trigger t ON t.tgrelid=r.oid AND NOT t.tgisinternal
`;
