// Read a string field from incomplete JSON tool arguments without evaluating it.
export function partialStringField(json,key){
  const match=new RegExp('"'+key+'"\\s*:\\s*"').exec(json||'');if(!match)return '';
  let out='';
  for(let i=match.index+match[0].length;i<json.length;i++){
    const c=json[i];if(c==='"')break;
    if(c!=='\\'){out+=c;continue;}
    const next=json[++i];if(next===undefined)break;
    if(next==='u'){const hex=json.slice(i+1,i+5);if(!/^[a-f\d]{4}$/i.test(hex))break;out+=String.fromCharCode(parseInt(hex,16));i+=4;}
    else out+=({'n':'\n','r':'\r','t':'\t','b':'\b','f':'\f','"':'"','\\':'\\','/':'/'}[next]??next);
  }return out;
}

// Formats complete or still-streaming JSON tool arguments for reading: strings are
// decoded, multi-line strings become indented blocks, and nesting becomes indentation.
// For example {"path":"a.js","edits":[{"newText":"x\ny"}]} becomes
//   path: a.js
//   edits:
//     - newText: |
//         x
//         y
export function readableArguments(json){
  const text=String(json||'');
  const stack=[];let out='',i=0,expectKey=false,itemKey=false,pendingItem=false;
  const indent=()=>'  '.repeat(Math.max(0,stack.length-1));
  // Starts a new "- " line for the next value in an array.
  const startValue=()=>{
    if(stack.at(-1)==='['&&pendingItem){out+='\n'+indent()+'- ';pendingItem=false;return true;}
    return false;
  };
  const readString=()=>{
    let s='';i++;
    for(;i<text.length;i++){
      const c=text[i];
      if(c==='"'){i++;return s;}
      if(c!=='\\'){s+=c;continue;}
      const next=text[++i];if(next===undefined)return s;
      if(next==='u'){const hex=text.slice(i+1,i+5);if(!/^[a-f\d]{4}$/i.test(hex))return s;s+=String.fromCharCode(parseInt(hex,16));i+=4;}
      else s+=({'n':'\n','r':'','t':'\t','b':'','f':'','"':'"','\\':'\\','/':'/'}[next]??next);
    }
    return s;
  };
  while(i<text.length){
    const c=text[i];
    if(/\s/.test(c)){i++;continue;}
    if(c==='{'||c==='['){
      const inItem=startValue();
      stack.push(c);
      if(c==='{'){expectKey=true;itemKey=inItem;}else pendingItem=true;
      i++;continue;
    }
    if(c==='}'||c===']'){stack.pop();expectKey=false;itemKey=false;i++;continue;}
    if(c===','){if(stack.at(-1)==='{')expectKey=true;else pendingItem=true;i++;continue;}
    if(c===':'){i++;continue;}
    if(c==='"'){
      const value=readString();
      if(stack.at(-1)==='{'&&expectKey){
        out+=itemKey?value+':':'\n'+indent()+value+':';
        itemKey=false;expectKey=false;continue;
      }
      startValue();
      if(value.includes('\n'))out+=' |\n'+value.split('\n').map(line=>'  '.repeat(stack.length)+line).join('\n');
      else out+=out.endsWith('- ')?value:' '+value;
      continue;
    }
    // Numbers, true, false and null.
    const literal=/^[^\s,\]}]+/.exec(text.slice(i))[0];
    startValue();
    out+=out.endsWith('- ')?literal:' '+literal;
    i+=literal.length;
  }
  return out.replace(/^\n/,'');
}
