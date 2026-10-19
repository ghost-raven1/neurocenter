'use strict';

/** Одинаковая инструкция при проверке публикации и формировании установочного пакета. */
function renderSkillInstruction(meta,body){
    return `---\nname: ${JSON.stringify(meta.slug)}\ndescription: ${JSON.stringify(meta.description||meta.slug)}\nmcp: ${JSON.stringify(meta.mcp||[])}\nplugins: ${JSON.stringify(meta.plugins||[])}\n---\n\n${body}`;
}
module.exports={renderSkillInstruction};
