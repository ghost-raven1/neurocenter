const unknown=(reason='The controller does not declare a JSON structure.')=>({'x-neurocenter-untyped':true,description:reason});

/** A bounded compiler-type projection documents declared shapes without inventing validation rules. */
export function createSchemaMapper(ts,checker){
    function schema(type,location,stack=new Set(),depth=0){
        if(!type||depth>14)return unknown('The declaration is recursive or exceeds the documentation depth limit.');
        if(type.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown))return unknown();
        if(type.flags&ts.TypeFlags.Never)return {not:{}};
        if(type.flags&(ts.TypeFlags.Void|ts.TypeFlags.Undefined))return undefined;
        if(type.flags&ts.TypeFlags.Null)return {nullable:true,'x-neurocenter-null-only':true};
        if(type.flags&ts.TypeFlags.StringLiteral)return {type:'string',enum:[type.value]};
        if(type.flags&ts.TypeFlags.NumberLiteral)return {type:'number',enum:[type.value]};
        if(type.flags&ts.TypeFlags.BooleanLiteral)return {type:'boolean',enum:[type.intrinsicName==='true']};
        if(type.flags&ts.TypeFlags.StringLike)return {type:'string'};
        if(type.flags&ts.TypeFlags.NumberLike)return {type:'number'};
        if(type.flags&ts.TypeFlags.BooleanLike)return {type:'boolean'};
        if(type.flags&ts.TypeFlags.BigIntLike)return unknown('JavaScript bigint requires explicit application serialization.');
        if(type.isUnion()){
            const nullable=type.types.some(item=>item.flags&ts.TypeFlags.Null);
            const variants=type.types.filter(item=>!(item.flags&(ts.TypeFlags.Null|ts.TypeFlags.Undefined|ts.TypeFlags.Void)));
            if(!variants.length)return nullable?{nullable:true,'x-neurocenter-null-only':true}:undefined;
            let result;
            const mapped=variants.map(item=>schema(item,location,stack,depth+1)||unknown());
            if(mapped.every(item=>item.enum?.length===1&&item.type===mapped[0].type))result={type:mapped[0].type,enum:[...new Set(mapped.flatMap(item=>item.enum))]};
            else if(mapped.length===1)result=mapped[0];
            else result={anyOf:mapped};
            return nullable?{...result,nullable:true}:result;
        }
        if(stack.has(type))return unknown('Recursive declaration; see the owning TypeScript type.');
        const next=new Set([...stack,type]),name=type.aliasSymbol?.name||type.getSymbol()?.name;
        if(name==='Date')return {type:'string',format:'date-time'};
        if(name==='Buffer'||name==='Uint8Array'||name==='ArrayBuffer')return {type:'string',format:'binary'};
        const promised=checker.getPromisedTypeOfPromise(type);
        if(promised)return schema(promised,location,next,depth+1);
        if(checker.isArrayType(type)||checker.isTupleType(type)){
            const items=checker.getTypeArguments(type);
            return {type:'array',items:items.length===1?(schema(items[0],location,next,depth+1)||unknown()):{anyOf:items.map(item=>schema(item,location,next,depth+1)||unknown())}};
        }
        if(type.getCallSignatures().length)return unknown('Executable values are not a JSON response contract.');
        const index=checker.getIndexTypeOfType(type,ts.IndexKind.String)||checker.getIndexTypeOfType(type,ts.IndexKind.Number);
        const declarations=type.getSymbol()?.declarations||[];
        if(name!=='Record'&&declarations.some(item=>/node_modules[/\\](?:@types[/\\](?:node|express)|typescript)|typescript[/\\]lib[/\\]lib\./.test(item.getSourceFile().fileName))){
            return unknown('A framework or runtime object has no declared JSON serialization.');
        }
        const properties={},required=[];
        const members=checker.getPropertiesOfType(type).filter(item=>!item.name.startsWith('__@'));
        if(members.length>128)return unknown('The declaration exceeds the documented JSON property limit.');
        for(const member of members){
            const declaration=member.valueDeclaration||member.declarations?.[0]||location;
            if(!declaration||member.flags&ts.SymbolFlags.Method)continue;
            const modifiers=ts.canHaveModifiers(declaration)?ts.getModifiers(declaration)||[]:[];
            if(modifiers.some(item=>item.kind===ts.SyntaxKind.PrivateKeyword||item.kind===ts.SyntaxKind.ProtectedKeyword))continue;
            const child=checker.getTypeOfSymbolAtLocation(member,declaration),mapped=schema(child,declaration,next,depth+1);
            if(mapped===undefined)continue;
            const description=ts.displayPartsToString(member.getDocumentationComment(checker));
            properties[member.name]=description?{...mapped,description:mapped.description?description+'\n'+mapped.description:description}:mapped;
            if(!(member.flags&ts.SymbolFlags.Optional)&&!(child.isUnion()&&child.types.some(item=>item.flags&ts.TypeFlags.Undefined)))required.push(member.name);
        }
        if(!members.length&&!index)return unknown();
        return {type:'object',...(Object.keys(properties).length?{properties}:{}),...(required.length?{required}:{}),...(index?{additionalProperties:schema(index,location,next,depth+1)||unknown()}:{} )};
    }
    return {schema:(type,location)=>schema(type,location),components:{schemas:{}}};
}
