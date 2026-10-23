const assert=require('node:assert/strict');
const net=require('node:net');
const {Pool}=require('pg');
const {createPool}=require('../src/database/pool.ts');

const scenario=process.argv[2];
const watchdog=setTimeout(()=>{throw Error('PostgreSQL disconnect fixture timed out');},6000);

function message(type,payload){const length=Buffer.alloc(4);length.writeInt32BE(payload.length+4);return Buffer.concat([Buffer.from(type),length,payload]);}
function row(name,value,oid){
    const field=Buffer.alloc(18);field.writeInt32BE(oid,6);field.writeInt16BE(oid===701?8:4,10);field.writeInt32BE(-1,12);
    const text=Buffer.from(String(value)),length=Buffer.alloc(4);length.writeInt32BE(text.length);
    return Buffer.concat([
        message('T',Buffer.concat([Buffer.from([0,1]),Buffer.from(name+'\0'),field])),
        message('D',Buffer.concat([Buffer.from([0,1]),length,text])),
        message('C',Buffer.from('SELECT 1\0')),message('Z',Buffer.from('I')),
    ]);
}

/** A loopback TCP peer speaks only startup/simple-query messages; pg.Client itself handles every EOF. */
async function socketFixture(){
    const sockets=new Set(),queries=[];let connections=0;
    const server=net.createServer(socket=>{
        const connection=++connections;sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
        let buffer=Buffer.alloc(0),started=false;
        socket.on('data',chunk=>{
            buffer=Buffer.concat([buffer,chunk]);
            if(!started){
                if(buffer.length<4||buffer.length<buffer.readInt32BE())return;
                buffer=buffer.subarray(buffer.readInt32BE());started=true;
                socket.write(Buffer.concat([message('R',Buffer.alloc(4)),message('Z',Buffer.from('I'))]));
            }
            while(buffer.length>=5&&buffer.length>=buffer.readInt32BE(1)+1){
                const type=String.fromCharCode(buffer[0]),length=buffer.readInt32BE(1),payload=buffer.subarray(5,length+1);buffer=buffer.subarray(length+1);
                if(type==='X'){socket.end();continue;}
                assert.equal(type,'Q');const sql=payload.toString('utf8').replace(/\0$/,'');queries.push(sql);
                if(connection===1&&['in-flight','remote-eof'].includes(scenario)){socket.end();continue;}
                socket.write(sql.includes('pg_database_size')?row('sz',123,701):row('value',1,23));
            }
        });
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const config={host:'127.0.0.1',port:server.address().port,user:'fixture',password:'synthetic',database:'fixture',ssl:false,max:1};
    return{config,queries,get connections(){return connections;},get closedConnections(){return connections-sockets.size;},disconnect(){[...sockets][0].end();},
        async waitForDisconnects(){await Promise.all([...sockets].map(socket=>new Promise(resolve=>socket.once('close',resolve))));},
        async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}

async function run(){
    const peer=await socketFixture();let pool;
    try{
        if(scenario.startsWith('remote-')){
            const {CatalogDb}=require('../src/catalog/catalog-db.ts');
            const catalog=Object.create(CatalogDb.prototype);
            const value=await catalog.remoteDbSize(`postgresql://fixture:synthetic@127.0.0.1:${peer.config.port}/fixture?sslmode=disable`);
            await peer.waitForDisconnects();
            return{value,connections:peer.connections,closedConnections:peer.closedConnections,queries:peer.queries};
        }
        pool=scenario==='unguarded'?new Pool(peer.config).on('error',()=>{}):createPool(peer.config,'disconnect-fixture');
        let releases=0;pool.on('release',()=>{releases++;});
        let client=await pool.connect();
        // Exercise reacquisition without installing any test-side client.error listener.
        for(let i=0;i<2;i++){client.release();client=await pool.connect();}releases=0;
        const ended=new Promise(resolve=>client.once('end',resolve));
        const abort=new AbortController();
        if(scenario==='owner-abort')client.once('error',error=>{abort.abort(error);client.release(true);});
        if(scenario==='pool-idle')client.release();
        let rejected;
        const pending=scenario==='in-flight'?client.query('SELECT 1').then(()=>{throw Error('Disconnected query unexpectedly succeeded');},error=>{rejected=error.message;}):undefined;
        if(!pending)peer.disconnect();
        await ended;await pending;
        const releasesAtDisconnect=releases,connectionsAtDisconnect=peer.connections;
        let laterRejected;
        if(!['owner-abort','pool-idle'].includes(scenario)){
            await client.query('SELECT 1').then(()=>{throw Error('Dead client unexpectedly queried');},error=>{laterRejected=error.message;});
            client.release();
        }
        const releasesAfterOwner=releases,connectionBeforeExplicitQuery=peer.connections;
        const replacement=await pool.query('SELECT 1');
        return{rejected,laterRejected,releasesAtDisconnect,releasesAfterOwner,connectionsAtDisconnect,connectionBeforeExplicitQuery,
            connectionsAfterExplicitQuery:peer.connections,aborted:abort.signal.aborted,value:replacement.rows[0].value,queries:peer.queries};
    }finally{await pool?.end();await peer.close();}
}

run().then(result=>{clearTimeout(watchdog);console.log('POSTGRES_FIXTURE_RESULT '+JSON.stringify(result));},error=>{clearTimeout(watchdog);console.error(error);process.exitCode=1;});
