const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {WebSocket}=require('ws');
const {fixture,cleanup,repository,loadWithMocks}=require('./helpers.cjs');

test('HTTP and WebSocket enforce auth, preserve Git paths and acknowledge input once',{timeout:20000},async()=>{
  const directory=fixture();
  const originalEnv={...process.env};
  const originalCwd=process.cwd();
  const processes=[];
  let server,client,api;
  try {
    repository(directory);
    fs.mkdirSync(path.join(directory,'new dir'));
    fs.writeFileSync(path.join(directory,'new dir','中文.txt'),'safe synthetic preview\n');
    fs.writeFileSync(path.join(directory,'.env'),'RELAY_AUTH_TOKEN=\n');
    Object.assign(process.env,{RELAY_AUTH_TOKEN:'',RELAY_PIN:'',ENABLE_TUNNEL:'false',AUTO_START_CODEX:'false',AUTO_OPEN_QR:'false',HOST:'127.0.0.1',CODEX_CWD:directory,CF_HOSTNAME:''});
    process.chdir(directory);
    const pty={spawn(){
      const proc={pid:processes.length+100,writes:[],write(data){this.writes.push(data);},resize(){},kill(){},
        onData(callback){this.data=callback;},onExit(callback){this.exit=callback;}};
      processes.push(proc);return proc;
    }};
    const loaded=loadWithMocks('index.js',{'node-pty':pty,'./tunnel':{stopActiveTunnel(){}}},
      'exports.__test={ensureAuthTokenConfigured,buildQrPayload,authLimiter,wss,spawnCodexPty};');
    server=loaded.server;api=loaded.__test;
    const token=await api.ensureAuthTokenConfigured();
    assert(token.length>=24);
    const saved=fs.readFileSync(path.join(directory,'.env'),'utf8');
    assert(saved.includes(JSON.stringify(token)),'generated token replaces the empty setting');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const headers={'x-relay-token':token};
    assert.equal((await fetch(base+'/api/health')).status,401);
    assert.equal((await fetch(base+'/api/health',{headers})).status,200);
    for(let i=0;i<8;i++)assert.equal((await fetch(base+'/api/auth/verify',{method:'POST',headers:{'Content-Type':'application/json','cf-connecting-ip':`198.51.100.${i}`,'x-forwarded-for':`198.51.100.${i}`},body:'{"token":"invalid"}'})).status,401);
    assert.equal((await fetch(base+'/api/health',{headers:{...headers,'cf-connecting-ip':'203.0.113.1'}})).status,429);
    api.authLimiter.clear('127.0.0.1');
    const qr=await (await fetch(base+'/api/qr',{headers})).json();
    assert.equal(qr.publicMagicUrl,null);assert.equal(qr.lanMagicUrl,null);
    const qrPage=await fetch(base+'/qr');
    assert.equal(qrPage.status,200);assert.equal(qrPage.headers.get('cache-control'),'no-store');
    const foreignHostStatus=await new Promise((resolve,reject)=>{
      const request=require('node:http').get(base+'/qr',{headers:{Host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);
    });
    assert.equal(foreignHostStatus,302);
    assert.equal((await fetch(base+'/qr',{headers:{Origin:'https://untrusted.example'},redirect:'manual'})).status,302);
    for(const asset of ['xterm.js','addon-fit.js','xterm.css','diff2html.css'])assert.equal((await fetch(base+'/vendor/'+asset)).status,200);
    const diff=await (await fetch(base+'/api/git/diff?file='+encodeURIComponent('new dir/中文.txt'),{headers})).json();
    assert(diff.ok&&diff.hasChanges&&diff.html.includes('safe synthetic preview'));
    assert.equal((await fetch(base+'/api/action',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"action":"approve"}'})).status,409);
    const originCode=await new Promise((resolve,reject)=>{
      const rejected=new WebSocket(base.replace('http','ws')+'/ws',{headers:{...headers,Origin:'https://foreign.example'}});
      rejected.on('unexpected-response',(_request,response)=>{response.resume();rejected.terminate();resolve(response.statusCode);});
      rejected.on('error',()=>{});rejected.on('open',()=>{rejected.terminate();reject(Error('Foreign origin accepted'));});
    });
    assert.equal(originCode,403);
    const messages=[];
    client=new WebSocket(base.replace('http','ws')+'/ws',{headers});
    client.on('message',raw=>messages.push(JSON.parse(raw)));
    await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
    async function waitFor(predicate){
      const deadline=Date.now()+2000;
      while(!predicate()){if(Date.now()>deadline)throw Error('WebSocket response timeout');await new Promise(resolve=>setTimeout(resolve,10));}
    }
    await waitFor(()=>messages.some(message=>message.type==='history'));
    const frame={type:'input',id:'synthetic-prompt-1',data:'test prompt\r'};
    client.send(JSON.stringify(frame));client.send(JSON.stringify(frame));
    await waitFor(()=>messages.filter(message=>message.type==='input-ack').length===2);
    assert.equal(processes[0].writes.length,1);
    client.send(JSON.stringify({type:'input',id:'oversize',data:'a'.repeat(16385)}));
    await waitFor(()=>messages.some(message=>message.type==='input-error'&&message.id==='oversize'));
    client.send(JSON.stringify({type:'restart'}));
    await waitFor(()=>processes.length===2);
    processes[0].exit({exitCode:0});
    client.send(JSON.stringify({type:'input',id:'synthetic-prompt-2',data:'replacement\r'}));
    await waitFor(()=>messages.some(message=>message.type==='input-ack'&&message.id==='synthetic-prompt-2'));
    assert.equal(processes[1].writes.length,1);
  } finally {
    client?.terminate();
    if(api){for(const ws of api.wss.clients)ws.terminate();await new Promise(resolve=>api.wss.close(resolve));}
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    process.chdir(originalCwd);
    for(const key of Object.keys(process.env))if(!(key in originalEnv))delete process.env[key];
    Object.assign(process.env,originalEnv);
    cleanup(directory);
  }
});
