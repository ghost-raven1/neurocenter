import {describe,expect,it} from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve('src');
const ddl=/\b(?:CREATE(?:\s+OR\s+REPLACE)?(?:\s+UNIQUE)?|ALTER|DROP)\s+(?:TABLE|INDEX|FUNCTION|TRIGGER|CONSTRAINT\s+TRIGGER|SCHEMA|EXTENSION)\b/i;

/** Resolve static SQL at the execution site, including imported aliases and local constants; no source module is executed. */
function ddlExecutors(sources:Record<string,string>,allowed:ReadonlySet<string>=new Set()):string[]{
    const options={noResolve:true,noLib:true,noEmit:true},host=ts.createCompilerHost(options);
    host.getSourceFile=(filename,language)=>sources[filename]===undefined?undefined:ts.createSourceFile(filename,sources[filename],language,true);
    const program=ts.createProgram(Object.keys(sources),options,host),checker=program.getTypeChecker(),failures:string[]=[];
    const imported=(declaration:ts.ImportSpecifier|ts.ImportClause|ts.NamespaceImport,name:string,seen:Set<ts.Node>):string=>{
        let parent:ts.Node=declaration;while(!ts.isImportDeclaration(parent)){if(!parent.parent)return '';parent=parent.parent;}
        if(!ts.isStringLiteral(parent.moduleSpecifier)||!parent.moduleSpecifier.text.startsWith('.'))return '';
        const target=path.resolve(path.dirname(parent.getSourceFile().fileName),parent.moduleSpecifier.text);
        const file=[target+'.ts',path.join(target,'index.ts')].map(value=>program.getSourceFile(value)).find(Boolean);if(!file)return '';
        const symbol=checker.getSymbolsInScope(file,ts.SymbolFlags.Value).find(value=>value.name===name);
        return (symbol?.declarations??[]).map(value=>declarationSql(value,seen)).join('');
    };
    const declarationSql=(declaration:ts.Declaration,seen:Set<ts.Node>):string=>{
        if(ts.isVariableDeclaration(declaration)||ts.isPropertyAssignment(declaration))return declaration.initializer?sql(declaration.initializer,seen):'';
        if(ts.isImportSpecifier(declaration))return imported(declaration,declaration.propertyName?.text??declaration.name.text,seen);
        if(ts.isImportClause(declaration))return imported(declaration,'default',seen);
        return '';
    };
    const sql=(node:ts.Node,seen=new Set<ts.Node>()):string=>{
        if(seen.has(node))return '';seen=new Set(seen).add(node);
        if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
        if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(span=>sql(span.expression,seen)+span.literal.text).join('');
        if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return sql(node.left,seen)+sql(node.right,seen);
        if(ts.isArrayLiteralExpression(node))return node.elements.map(value=>sql(value,seen)).join(';');
        if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='join')return sql(node.expression.expression,seen);
        if(ts.isParenthesizedExpression(node)||ts.isAsExpression(node)||ts.isNonNullExpression(node))return sql(node.expression,seen);
        if(ts.isPropertyAccessExpression(node)){
            const namespace=checker.getSymbolAtLocation(node.expression)?.declarations?.find(ts.isNamespaceImport);
            if(namespace)return imported(namespace,node.name.text,seen);
        }
        return (checker.getSymbolAtLocation(node)?.declarations??[]).map(value=>declarationSql(value,seen)).join('');
    };
    for(const file of program.getSourceFiles()){
        const visit=(node:ts.Node)=>{
            if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='query'&&node.arguments[0]){
                const statement=sql(node.arguments[0]);
                // Row text may contain SQL examples. Executed dynamic DDL still counts as DDL.
                const executable=statement.replace(/'(?:''|[^'])*'/g,"''");
                const changesSchema=ddl.test(executable)||/\bEXECUTE\s+(?:format\s*\()?\s*'[^']*\b(?:CREATE|ALTER|DROP)\s/i.test(statement);
                const databaseBootstrap=file.fileName===path.join(root,'database/production-init.cli.ts')&&!/\b(?:TABLE|INDEX|TRIGGER|FUNCTION|SCHEMA)\b/i.test(executable);
                if(changesSchema&&!allowed.has(file.fileName)&&!databaseBootstrap)failures.push(path.relative(root,file.fileName)+':'+(file.getLineAndCharacterOfPosition(node.getStart()).line+1));
            }
            ts.forEachChild(node,visit);
        };visit(file);
    }
    return failures;
}

describe('Catalog DDL has one execution boundary',()=>{
    it('Rejects a domain executor of imported frozen SQL through an alias and a local template',()=>{
        const schema=path.join(root,'schema.ts'),domain=path.join(root,'domain.ts');
        expect(ddlExecutors({[schema]:"export const ACCESS_SCHEMA_SQL='CREATE TABLE security_events(id text)';",
            [domain]:"import {ACCESS_SCHEMA_SQL as schema} from './schema'; const statement=`${schema}; SELECT 1`; pool.query(statement);"})).toEqual(['domain.ts:1']);
    });
    it('Allows parameterized data writes with SQL examples and the designated migration runner',()=>{
        const domain=path.join(root,'domain.ts'),runner=path.join(root,'runner.ts');
        expect(ddlExecutors({[domain]:"pool.query(\"INSERT INTO notes(body) VALUES('CREATE TABLE example(id text)')\");",
            [runner]:"client.query('CREATE TABLE example(id text)');"},new Set([runner]))).toEqual([]);
    });
    it('Current domain modules do not execute schema SQL, even when the SQL itself is registered elsewhere',()=>{
        const sources=Object.fromEntries(fs.readdirSync(root,{recursive:true}).filter(value=>typeof value==='string'&&value.endsWith('.ts'))
            .map(value=>{const filename=path.join(root,String(value));return [filename,fs.readFileSync(filename,'utf8')];}));
        expect(ddlExecutors(sources,new Set([path.join(root,'database/migrations.ts')]))).toEqual([]);
    });
});
