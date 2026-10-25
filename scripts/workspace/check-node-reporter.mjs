/** Retain only the final aggregate Node summary, excluding names, paths and diagnostics. */
export default async function* nodeCheckReporter(events){
    for await(const event of events)if(event.type==='test:summary'&&event.data.file===undefined){
        yield JSON.stringify({schemaVersion:1,success:event.data.success,counts:event.data.counts})+'\n';
    }
}
