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
