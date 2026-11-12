// Line diff (Myers) and unified hunks for the Changes panel.
const MAX_EDITS=1500;

export function splitLines(text){
  if(!text)return [];
  const lines=String(text).replace(/\r\n/g,'\n').split('\n');
  if(lines.at(-1)==='')lines.pop();
  return lines;
}

function myers(a,b){
  const n=a.length,m=b.length,max=n+m,off=max+1;
  const v=new Int32Array(2*max+3),trace=[];
  for(let d=0;d<=max;d++){
    if(d>MAX_EDITS)return null;
    trace.push(v.slice());
    for(let k=-d;k<=d;k+=2){
      let x=k===-d||(k!==d&&v[off+k-1]<v[off+k+1])?v[off+k+1]:v[off+k-1]+1;
      let y=x-k;
      while(x<n&&y<m&&a[x]===b[y]){x++;y++;}
      v[off+k]=x;
      if(x>=n&&y>=m){
        const ops=[];
        for(let step=d;step>=0;step--){
          const prev=trace[step],kk=x-y;
          const prevK=kk===-step||(kk!==step&&prev[off+kk-1]<prev[off+kk+1])?kk+1:kk-1;
          const prevX=prev[off+prevK],prevY=prevX-prevK;
          while(x>prevX&&y>prevY){x--;y--;ops.push(['eq',x,y]);}
          if(step>0){if(x===prevX){y--;ops.push(['add',x,y]);}else{x--;ops.push(['del',x,y]);}}
        }
        return ops.reverse();
      }
    }
  }
  return null;
}

// Returns [{type:'eq'|'del'|'add', text, old, new}] with 1-based line numbers.
export function diffLines(before,after){
  const a=splitLines(before),b=splitLines(after);
  let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  let endA=a.length,endB=b.length;
  while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
  const midA=a.slice(start,endA),midB=b.slice(start,endB);
  let middle=midA.length+midB.length<=8000?myers(midA,midB):null;
  if(!middle)middle=[...midA.map((_,i)=>['del',i,0]),...midB.map((_,j)=>['add',midA.length,j])];
  const rows=[];
  for(let i=0;i<start;i++)rows.push({type:'eq',text:a[i],old:i+1,new:i+1});
  for(const [type,x,y] of middle){
    if(type==='eq')rows.push({type,text:midA[x],old:start+x+1,new:start+y+1});
    else if(type==='del')rows.push({type,text:midA[x],old:start+x+1,new:null});
    else rows.push({type,text:midB[y],old:null,new:start+y+1});
  }
  for(let i=0;i<a.length-endA;i++)rows.push({type:'eq',text:a[endA+i],old:endA+i+1,new:endB+i+1});
  return rows;
}

// Groups changed rows with surrounding context into hunks.
export function hunks(rows,context=3){
  const changed=rows.map((r,i)=>r.type==='eq'?-1:i).filter(i=>i>=0);
  const groups=[];
  for(const index of changed){
    const last=groups.at(-1);
    if(last&&index-last.end<=context*2+1)last.end=index;
    else groups.push({start:index,end:index});
  }
  return groups.map(({start,end})=>{
    const lines=rows.slice(Math.max(0,start-context),Math.min(rows.length,end+context+1));
    const first=lines.find(l=>l.old!=null),firstNew=lines.find(l=>l.new!=null);
    return {oldStart:first?.old??0,newStart:firstNew?.new??0,lines};
  });
}

export function countChanges(rows){
  let added=0,removed=0;
  for(const row of rows){if(row.type==='add')added++;else if(row.type==='del')removed++;}
  return {added,removed};
}
