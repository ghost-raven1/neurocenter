/** Administrative tests never inherit the application's database or a default PostgreSQL port. */
export function ownedAccessTestAdminUrl(value:string):URL{
    let url:URL;try{url=new URL(value);}catch{throw new Error('Provide an explicitly owned PostgreSQL test admin URL.');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!=='127.0.0.1'||!url.port||url.port==='5432'||url.pathname!=='/postgres'||url.search||url.hash)
        throw new Error('Provide an explicitly owned loopback PostgreSQL admin URL on a non-default port.');
    return url;
}
