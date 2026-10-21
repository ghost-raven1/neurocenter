/** Fixed audited retirement scope. Operator input cannot choose another skill, project or filesystem path. */
exports.LEGACY_DEMO_POLICY='legacy-demo-retirement-v1';
exports.LEGACY_DEMO_SKILLS=Object.freeze([
    {id:'common/memory',version:2,sha256:'726cf5ccf2ac70051ca12525cb14458b563e5030050461a069eb144078ab4af7',reason:'Нет исходного v1 и подтверждённой зависимости knowledge-graph-mcp.'},
    {id:'common/jest-test',version:2,sha256:'116ac4b66aa51d66bd62c0d0ad0e0729d701e5d3950efa9486d6fda9815671d4',reason:'Нет исходного v1 и подтверждённой source-поставки. Сохранённые v2 bytes остаются в архиве.'},
    {id:'project-prj-lancedb/code-review-helper',version:1,sha256:'bab4f809e015f51377cae47f3b9531795c193c67a0c00d4d8914f3dc10b2b806',projectId:'prj-lancedb',reason:'Проект отсутствует; зависимости code-review-mcp/review-bot не подтверждены.'},
]);
exports.LEGACY_DEMO_REFS=Object.freeze([
    {projectId:'prj-dossier-ko',id:'ai-plug-96ba266b-3c39-48ab-94fd-ffba4779384b',kind:'plugin'},
    {projectId:'prj-dossier-ko',id:'project-prj-dossier-ko/browser-automation',kind:'skill'},
    {projectId:'prj-dossier-ko',id:'rag-index-monitor',kind:'skill'},
]);
