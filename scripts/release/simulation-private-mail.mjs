import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {platform} from 'node:os';
export async function parsePrivateMail(raw,{python=platform()==='win32'?'python':'python3',headersOnly=false}={}) {
  assert(Buffer.isBuffer(raw)&&raw.length<=2*1024*1024);assert.equal(typeof headersOnly,'boolean');
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-c',"import sys,json; from email.parser import BytesParser; from email import policy; m=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read()); assert len(m.get_all('Message-ID',[]))==1 and len(m.get_all('Subject',[]))<=1 and len(m.get_all('In-Reply-To',[]))<=1 and len(m.get_all('References',[]))<=1; raw={k.lower():' '.join(v.splitlines()).strip() for k,v in m.raw_items()}; ids={'messageId':'Message-ID','inReplyTo':'In-Reply-To','references':'References'}; parsed={k:str(m.get(n,'')).strip() for k,n in ids.items()}; defects={k:[type(d).__name__ for d in getattr(m.get(n,''),'defects',())] for k,n in ids.items()}; b=m.get_body(preferencelist=('plain',)); headers_only=sys.argv[1]=='true'; assert headers_only or b is not None; sys.stdout.write(json.dumps({'text':'' if headers_only else b.get_content(),**{k:raw.get(n.lower(),'') for k,n in ids.items()},'parsedHeaders':parsed,'headerDefects':defects,'subject':str(m.get('Subject','')).strip()}))",String(headersOnly)],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='',size=0;const timer=setTimeout(()=>{child.kill();reject(Error('Private MIME parser timeout'));},10000);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024){child.kill();return;}output+=chunk;});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('Private MIME parser unavailable'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0||size>2*1024*1024)return reject(Error('Private MIME parser failed'));try{resolve(JSON.parse(output));}catch{reject(Error('Private MIME parser invalid result'));}});
    child.stdin.on('error',()=>{});child.stdin.end(raw);
  });
}
