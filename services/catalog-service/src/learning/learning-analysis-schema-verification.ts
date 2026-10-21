import type {Pool} from 'pg';
import {CATALOG_SCHEMA_FACTS_SQL} from '../database/schema-catalog';
import {LEARNING_ANALYSIS_SCHEMA_CONTRACT} from './learning-analysis-schema-contract';
export const LEARNING_ANALYSIS_SCHEMA_ISSUES_SQL=`WITH expected AS (
 SELECT * FROM jsonb_to_recordset($analysis_contract$${JSON.stringify(LEARNING_ANALYSIS_SCHEMA_CONTRACT)}$analysis_contract$::jsonb)
 AS objects(kind text,id text,definition jsonb)
),actual AS (${CATALOG_SCHEMA_FACTS_SQL})
SELECT expected.kind||':'||expected.id AS issue FROM expected LEFT JOIN actual USING(kind,id)
WHERE actual.definition IS DISTINCT FROM expected.definition ORDER BY expected.kind,expected.id`;
export const LEARNING_ANALYSIS_SCHEMA_ASSERT_SQL=`DO $verify_learning_analysis$ DECLARE missing text; BEGIN
 SELECT string_agg(issue,', ') INTO missing FROM (${LEARNING_ANALYSIS_SCHEMA_ISSUES_SQL} LIMIT 10) issues;
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'Learning analysis schema is incomplete or incompatible: %',missing; END IF;
END $verify_learning_analysis$;`;
/** Readiness refuses a partially created queue or a weakened lease/provenance constraint. */
export async function assertLearningAnalysisSchema(db:Pick<Pool,'query'>):Promise<void>{
 const {rows}=await db.query<{issue:string}>(LEARNING_ANALYSIS_SCHEMA_ISSUES_SQL);
 if(rows.length)throw new Error('Схема анализа обучения не готова: '+rows.slice(0,10).map(row=>row.issue).join(', '));
}
