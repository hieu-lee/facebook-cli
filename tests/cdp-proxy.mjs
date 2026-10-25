// Test-only CDP relay: hold one response after real Chrome completes the command.
import http from 'node:http';
import crypto from 'node:crypto';
export async function proxy(url){
 const clients=new Set(),watches=new Map();let gate;
 const server=http.createServer();
 server.on('upgrade',(req,s,head)=>{
  clients.add(s);s.on('close',()=>clients.delete(s));s.on('error',()=>{});
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
  let buffer=Buffer.alloc(0);const ws=new WebSocket(url),queue=[],methods=new Map();
  const send=(payload,opcode=1)=>{const b=Buffer.from(payload);let h;if(b.length<126)h=Buffer.from([128|opcode,b.length]);else if(b.length<65536){h=Buffer.alloc(4);h[0]=128|opcode;h[1]=126;h.writeUInt16BE(b.length,2)}else{h=Buffer.alloc(10);h[0]=128|opcode;h[1]=127;h.writeBigUInt64BE(BigInt(b.length),2)}if(!s.destroyed)s.write(Buffer.concat([h,b]))};
  ws.onopen=()=>{for(const q of queue)ws.send(q)};
  ws.onmessage=ev=>{const m=JSON.parse(ev.data),method=methods.get(m.id);methods.delete(m.id);const done=watches.get(method);if(done){watches.delete(method);done()}
   if(gate&&method===gate.method){const current=gate;gate=undefined;current.release=()=>send(ev.data);current.held()}else send(ev.data)};
  ws.onerror=()=>s.destroy();ws.onclose=()=>s.destroy();s.on('close',()=>ws.close());
  const receive=b=>{try{buffer=Buffer.concat([buffer,b]);while(buffer.length>=2){const opcode=buffer[0]&15,masked=buffer[1]&128;let n=buffer[1]&127,offset=2;if(n===126){if(buffer.length<4)return;n=buffer.readUInt16BE(2);offset=4}else if(n===127){if(buffer.length<10)return;n=Number(buffer.readBigUInt64BE(2));offset=10}if(n>16*1024*1024)throw Error('oversized test CDP frame');if(buffer.length<offset+(masked?4:0)+n)return;const mask=masked?buffer.subarray(offset,offset+4):null;offset+=masked?4:0;const payload=Buffer.from(buffer.subarray(offset,offset+n));buffer=buffer.subarray(offset+n);if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];if(opcode===8){s.end();return}if(opcode===9){send(payload,10);continue}if(opcode!==1)throw Error('unexpected test CDP opcode');const text=payload.toString(),m=JSON.parse(text);methods.set(m.id,m.method);if(ws.readyState===WebSocket.OPEN)ws.send(text);else queue.push(text)}}catch{s.destroy()}};
  s.on('data',receive);if(head.length)receive(head);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 return {url:'ws://127.0.0.1:'+server.address().port+'/proxy',
  hold(method){const current={method};current.promise=new Promise(resolve=>{current.held=resolve});gate=current;return {held:current.promise,release:()=>current.release?.()}},
  after(method){return new Promise(resolve=>watches.set(method,resolve))},
  async close(){for(const s of clients)s.destroy();await new Promise(resolve=>server.close(resolve))}};
}
