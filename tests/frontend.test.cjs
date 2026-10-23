const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {project}=require('./helpers.cjs');

async function browser({delayedWrites=false}={}){
  const elements=new Map(),sockets=[],timers=[],writes=[];
  function element(){return {value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,
    classList:{add(){},remove(){},toggle(){}},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},
    appendChild(){},prepend(){},setAttribute(){},focus(){}};}
  const document={getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    querySelectorAll(){return [];},createElement:element,title:'Relay'};
  const terminal={cols:80,rows:24,output:'',resets:0,loadAddon(){},open(){},onData(){},clear(){},
    reset(){this.output='';this.resets++;},resize(cols,rows){this.cols=cols;this.rows=rows;},
    write(data,callback){const complete=()=>{this.output+=data;callback?.();};delayedWrites?writes.push(complete):complete();}};
  class Socket {
    static OPEN=1;
    constructor(){this.readyState=0;this.listeners={};this.sent=[];sockets.push(this);}
    addEventListener(type,fn){this.listeners[type]=fn;}
    send(raw){this.sent.push(JSON.parse(raw));}
    close(){this.readyState=3;this.dispatch('close');}
    dispatch(type,data){this.listeners[type]?.(data);}
    open(){this.readyState=1;this.dispatch('open');}
    message(message){this.dispatch('message',{data:JSON.stringify(message)});}
  }
  const storage=new Map([['codex_relay_auth_token','synthetic-browser-test-credential']]);
  const context={document,URLSearchParams,WebSocket:Socket,navigator:{},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(fn,delay){const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cancelled=true;},
    setInterval(){return 1;},clearInterval(){},
    fetch:async url=>({ok:true,status:200,json:async()=>url.includes('auth')?{ok:true,cwd:'/synthetic'}:{ok:true,files:[]}}),
    window:{location:{hostname:'localhost',host:'localhost:3210',protocol:'http:',search:'',pathname:'/',hash:''},
      history:{replaceState(){}},addEventListener(){},Terminal:function(){return terminal;},FitAddon:{FitAddon:function(){this.proposeDimensions=()=>({cols:120,rows:35});}}}};
  vm.runInNewContext(fs.readFileSync(path.join(project,'public','app.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,sockets,timers,terminal,writes,submit(){elements.get('prompt-form').listeners.submit({preventDefault(){}});}};
}

test('Send preserves disconnected drafts and clears only an acknowledged unchanged draft',async()=>{
  const page=await browser(),input=page.elements.get('prompt-input');
  input.value='keep this draft';page.submit();assert.equal(input.value,'keep this draft');
  const socket=page.sockets[0];socket.open();page.submit();
  assert.equal(input.value,'keep this draft');
  const first=socket.sent.find(message=>message.type==='input');assert(first.id);
  page.submit();assert.equal(socket.sent.filter(message=>message.type==='input').length,1);
  socket.message({type:'input-ack',id:first.id});assert.equal(input.value,'');
  input.value='second';page.submit();const second=socket.sent.at(-1);
  input.value='newer unsent text';socket.message({type:'input-ack',id:second.id});
  assert.equal(input.value,'newer unsent text');
});

test('shared screen resizing waits for pending output instead of changing local geometry',async()=>{
  const page=await browser({delayedWrites:true}),socket=page.sockets[0];socket.open();
  page.timers.find(timer=>timer.delay===80).fn();
  assert.equal(socket.sent.at(-1).type,'resize');assert.equal(socket.sent.at(-1).cols,120);
  assert.equal(page.terminal.cols,80,'measuring the viewport must not resize the local grid');
  socket.message({type:'output',data:'old-size text'});
  socket.message({type:'history',cols:40,rows:12,data:'shared snapshot'});
  socket.message({type:'output',data:' new output'});
  assert.equal(page.terminal.cols,80);
  page.writes.shift()();assert.equal(page.terminal.cols,40);assert.equal(page.terminal.rows,12);
  page.writes.shift()();page.writes.shift()();
  assert.equal(page.terminal.output,'shared snapshot new output');
});

test('a closed terminal retains drafts and restart invalidates the pending input ID',async()=>{
  const page=await browser(),socket=page.sockets[0],input=page.elements.get('prompt-input');socket.open();
  socket.message({type:'status',running:false,kind:'unknown'});input.value='saved draft';page.submit();
  assert.equal(socket.sent.length,0);assert.equal(input.value,'saved draft');
  assert(page.elements.get('terminal-state').textContent.includes('未提供退出状态'));
  socket.message({type:'status',running:true});page.submit();const oldId=socket.sent.at(-1).id;
  socket.message({type:'session-reset',cols:40,rows:12});socket.message({type:'input-ack',id:oldId});
  assert.equal(input.value,'saved draft');page.submit();assert.notEqual(socket.sent.at(-1).id,oldId);
});

test('uncertain delivery retries with the same ID and reconnect history replaces the display',async()=>{
  const page=await browser(),input=page.elements.get('prompt-input'),socket=page.sockets[0];
  socket.open();input.value='uncertain';page.submit();const first=socket.sent.at(-1);
  page.timers.find(timer=>timer.delay===7000).fn();page.submit();
  assert.equal(socket.sent.at(-1).id,first.id);assert.equal(input.value,'uncertain');
  socket.message({type:'history',data:'previous output'});socket.message({type:'output',data:' live'});
  socket.message({type:'history',data:'previous output live'});
  assert.equal(page.terminal.output,'previous output live');assert.equal(page.terminal.resets,2);
  socket.close();page.timers.find(timer=>timer.delay===2000).fn();
  const replacement=page.sockets[1];replacement.open();
  socket.message({type:'output',data:'stale'});assert(!page.terminal.output.includes('stale'));
  page.submit();assert.equal(replacement.sent.at(-1).id,first.id);
});
