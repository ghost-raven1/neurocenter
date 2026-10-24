import {createRequire} from 'node:module';

const {ownedTestPostgresAdmin}=createRequire(import.meta.url)('../../../scripts/test/owned-postgres.fixture.mjs') as {ownedTestPostgresAdmin:(value:string|undefined)=>URL};
type FixtureEnvironment={TEST_ADMIN_PG_URL?:string;CATALOG_TEST_PG_URL?:string};
const message='Set TEST_ADMIN_PG_URL or CATALOG_TEST_PG_URL to an explicitly owned PostgreSQL admin URL with credentials, 127.0.0.1, a non-default port and /postgres; URL overrides are forbidden.';

/** Admit explicit test infrastructure before constructing a Pool; never inherit libpq identity or application defaults. */
export function callerOwnedPostgresAdmin(environment:FixtureEnvironment=process.env):URL{
    const value=environment.TEST_ADMIN_PG_URL??environment.CATALOG_TEST_PG_URL;
    let url:URL;
    try{
        if(typeof value!=='string'||value!==value.trim()||value.includes('?')||value.includes('#'))throw new Error(message);
        url=ownedTestPostgresAdmin(value);
        if(url.port==='0'||!url.username||!url.password
            ||/[\x00-\x1f\x7f]/.test(decodeURIComponent(url.username)+decodeURIComponent(url.password)))throw new Error(message);
    }catch{throw new Error(message);}
    return url;
}
