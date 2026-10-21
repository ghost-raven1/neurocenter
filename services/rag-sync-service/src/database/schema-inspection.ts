import type {PoolClient} from 'pg';

export interface SchemaObjects {tables:readonly string[];indexes?:readonly string[];functions?:readonly string[];triggers?:readonly string[];}

/** Only migration-owned objects are compared; quota triggers and generation search indexes have independent owners. */
export async function inspectSchema(db:Pick<PoolClient,'query'>,objects:SchemaObjects):Promise<unknown>{
    const tables=(await db.query(`SELECT c.relname AS name,c.relkind AS kind,c.relpersistence AS persistence,c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[objects.tables])).rows;
    const columns=(await db.query(`SELECT c.relname AS table_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
        pg_get_expr(d.adbin,d.adrelid) AS default_value,a.attidentity AS identity,a.attgenerated AS generated
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,[objects.tables])).rows;
    const constraints=(await db.query(`SELECT c.relname AS table_name,k.contype AS type,pg_get_constraintdef(k.oid,true) AS definition,k.convalidated AS validated,
        k.condeferrable AS deferrable,k.condeferred AS deferred
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname,k.contype,pg_get_constraintdef(k.oid,true)`,[objects.tables])).rows;
    const indexes=(await db.query(`SELECT c.relname AS name,pg_get_indexdef(c.oid) AS definition,i.indisvalid AS valid,i.indisready AS ready
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[objects.indexes??[]])).rows;
    const functions=(await db.query(`SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result,
        l.lanname AS language,p.prosrc AS source,p.provolatile AS volatility,p.proisstrict AS strict,p.prosecdef AS security_definer,p.proparallel AS parallel,p.proconfig AS configuration
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
        WHERE n.nspname='public' AND p.proname=ANY($1::text[]) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,[objects.functions??[]])).rows;
    const triggers=(await db.query(`SELECT t.tgname AS name,c.relname AS table_name,t.tgtype AS type,t.tgenabled AS enabled,t.tgdeferrable AS deferrable,t.tginitdeferred AS deferred,p.proname AS function_name,
        n.nspname AS function_schema,encode(t.tgargs,'hex') AS arguments,pg_get_expr(t.tgqual,t.tgrelid) AS condition
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_namespace tn ON tn.oid=c.relnamespace WHERE tn.nspname='public' AND t.tgname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY t.tgname`,[objects.triggers??[]])).rows;
    return {tables,columns,constraints,indexes,functions,triggers};
}
