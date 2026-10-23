const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {fixture,cleanup,loadWithMocks}=require('./helpers.cjs');

function harness(){
  const directory=fixture(),calls=[],commands=[];
  const binary=path.join(directory,'cloudflared');fs.writeFileSync(binary,'synthetic');
  fs.mkdirSync(path.join(directory,'.cloudflared'));fs.writeFileSync(path.join(directory,'.cloudflared','cert.pem'),'synthetic');
  const childProcess={spawn(command,args,options){
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,killed:false,
      kill(){this.killed=true;this.exitCode=0;this.emit('exit',0);}});
    calls.push({command,args,options,child});return child;
  },execFile(command,args,options,callback){commands.push(args);callback(null,'','');}};
  const api=loadWithMocks('tunnel.js',{'child_process':childProcess,'cloudflared':{bin:binary,install(){throw Error('Unexpected network download');}},
    'os':{...os,platform:()=> 'linux',homedir:()=>directory}});
  return {api,calls,commands,directory,async start(options){
    const promise=api.startCloudflareTunnel({port:3210,...options});
    // Register a handler immediately so intentionally rejected startup is observed.
    promise.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));return {promise,child:calls.at(-1)?.child};
  },close(){api.stopActiveTunnel();cleanup(directory);}};
}

test('quick tunnel is advertised only after URL and registered connection, and becomes unavailable on exit',async()=>{
  const h=harness();try{
    const {promise,child}=await h.start({});let ready=false;promise.then(()=>{ready=true;});
    child.stderr.write('https://synthetic-test.trycloudflare.com\n');await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);
    child.stderr.write('Registered tunnel connection\n');const tunnel=await promise;assert(tunnel.isReady());
    child.exitCode=1;child.emit('exit',1);assert.equal(tunnel.isReady(),false);
  }finally{h.close();}
});

test('early exit and startup timeout reject without advertising a URL',async()=>{
  for(const mode of ['exit','timeout']){
    const h=harness();try{
      const {promise,child}=await h.start({timeoutMs:25});
      if(mode==='exit'){child.exitCode=1;child.emit('exit',1);}
      await assert.rejects(promise,/exited|timeout/);
    }finally{h.close();}
  }
});

test('token mode requires a hostname and keeps the synthetic token out of argv',async()=>{
  const h=harness();try{
    await assert.rejects(h.api.startCloudflareTunnel({port:3210,tunnelToken:'synthetic-tunnel-token'}),/CF_HOSTNAME/);
    const {promise,child}=await h.start({hostname:'codex.example.com',tunnelToken:'synthetic-tunnel-token'});
    assert(!h.calls[0].args.some(arg=>arg.includes('synthetic-tunnel-token')));
    assert(h.calls[0].options.env.TUNNEL_TOKEN==='synthetic-tunnel-token');
    child.stderr.write('Registered tunnel connection');assert.equal((await promise).mode,'custom-token');
    assert.equal(h.commands.length,0);
  }finally{h.close();}
});

test('custom certificate mode preserves DNS records unless overwrite is explicitly enabled',async()=>{
  for(const overwriteDns of [false,true]){
    const h=harness();try{
      const {promise,child}=await h.start({hostname:'codex.example.com',overwriteDns});
      const route=h.commands.find(args=>args.includes('dns'));
      assert.equal(route.includes('--overwrite-dns'),overwriteDns);
      child.stderr.write('Registered tunnel connection');assert.equal((await promise).mode,'custom-cert');
    }finally{h.close();}
  }
});
