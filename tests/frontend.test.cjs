const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {project}=require('./helpers.cjs');

async function browser({delayedWrites=false,preferences={},browserLanguage='zh-CN'}={}){
  const elements=new Map(),sockets=[],timers=[],writes=[],actions=new Map();
  function element(){return {value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,
    classList:{add(){},remove(){},toggle(){}},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},
    open:false,showModal(){this.open=true;},close(){this.open=false;},
    appendChild(){},prepend(){},setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name];},focus(){}};}
  for(const match of fs.readFileSync(path.join(project,'public','index.html'),'utf8').matchAll(/data-action="([^"]+)"/g)) {
    const button=element();button['data-action']=match[1];actions.set(match[1],button);
  }
  const document={documentElement:{lang:''},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    querySelectorAll(selector){
      if(selector==='[data-action]')return [...actions.values()];
      if(selector==='[data-language-select]')return ['auth-language','ui-language'].map(id=>this.getElementById(id));
      return [];
    },createElement:element,title:'Relay'};
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
  const storage=new Map([['codex_relay_auth_token','synthetic-browser-test-credential'],...Object.entries(preferences)]);
  const context={document,URLSearchParams,WebSocket:Socket,navigator:{language:browserLanguage},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(fn,delay){const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cancelled=true;},
    setInterval(){return 1;},clearInterval(){},
    fetch:async url=>({ok:true,status:200,json:async()=>url.includes('auth')?{ok:true,cwd:'/synthetic'}:{ok:true,files:[]}}),
    window:{location:{hostname:'localhost',host:'localhost:3210',protocol:'http:',search:'',pathname:'/',hash:''},
      history:{replaceState(){}},addEventListener(){},Terminal:function(options){terminal.options=options;return terminal;},FitAddon:{FitAddon:function(){this.proposeDimensions=()=>({cols:120,rows:35});}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(project,'public','i18n.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(project,'public','app.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,sockets,timers,terminal,writes,actions,storage,document,i18n:context.window.RelayI18n,submit(){elements.get('prompt-form').listeners.submit({preventDefault(){}});}};
}

test('language and font preferences restore and change without replacing the terminal or draft',async()=>{
  const page=await browser({preferences:{codex_relay_language:'en',codex_relay_font_size:'17'}}),socket=page.sockets[0];socket.open();
  assert.equal(page.document.documentElement.lang,'en');assert.equal(page.terminal.options.fontSize,17);
  assert.equal(page.elements.get('connection-status').textContent,'Connected');
  const input=page.elements.get('prompt-input');input.value='unsent draft';
  const language=page.elements.get('ui-language');language.value='zh-CN';language.listeners.change();
  assert.equal(page.storage.get('codex_relay_language'),'zh-CN');
  assert.equal(page.elements.get('auth-language').value,'zh-CN');
  assert.equal(page.elements.get('connection-status').textContent,'已连接');
  const font=page.elements.get('font-size');font.value='15';font.listeners.change();
  assert.equal(page.terminal.options.fontSize,15);assert.equal(page.storage.get('codex_relay_font_size'),'15');
  assert.equal(input.value,'unsent draft');assert.equal(page.sockets.length,1);assert.equal(page.terminal.resets,0);
  assert(socket.sent.every(message=>message.type==='resize'));
});

test('unsupported preferences fall back and both languages cover visible interface keys',async()=>{
  const page=await browser({preferences:{codex_relay_language:'xx',codex_relay_font_size:'999'},browserLanguage:'en-US'});
  assert.equal(page.document.documentElement.lang,'en');assert.equal(page.terminal.options.fontSize,13);
  const dictionaries=page.i18n.messages;
  assert.deepEqual(Object.keys(dictionaries.en).sort(),Object.keys(dictionaries['zh-CN']).sort());
  for(const match of fs.readFileSync(path.join(project,'public','index.html'),'utf8').matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
    assert(dictionaries.en[match[1]],`Missing English: ${match[1]}`);
    assert(dictionaries['zh-CN'][match[1]],`Missing Chinese: ${match[1]}`);
  }
});

test('workspace labels use the folder name while preserving the full path as text',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  socket.message({type:'status',running:true,cwd:'C:\\work\\my-project'});
  assert.equal(page.elements.get('cwd-label').textContent,'my-project');
  assert.equal(page.elements.get('workspace-path').textContent,'C:\\work\\my-project');
});

test('restart requires confirmation and cancellation never sends a restart',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  const button=page.elements.get('btn-restart'),dialog=page.elements.get('restart-dialog');
  button.listeners.click();assert(dialog.open);assert.equal(socket.sent.length,0);
  page.elements.get('restart-cancel').listeners.click();assert(!dialog.open);assert.equal(socket.sent.length,0);
  button.listeners.click();page.elements.get('restart-confirm').listeners.click();
  assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].type,'restart');assert(button.disabled);
  button.listeners.click();assert(!dialog.open);
  socket.message({type:'session-reset',cols:80,rows:24});assert(!button.disabled);
  assert(page.elements.get('action-status').textContent.includes('重新创建'));
  button.listeners.click();socket.close();assert(!dialog.open);
  page.elements.get('restart-confirm').listeners.click();assert.equal(socket.sent.filter(message=>message.type==='restart').length,1);
});

test('mobile menu buttons send separate navigation and confirmation actions',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  for(const action of ['up','down','tab','enter']) {
    page.actions.get(action).listeners.click();
    assert.equal(socket.sent.at(-1).type,'action');
    assert.equal(socket.sent.at(-1).action,action);
    socket.message({type:'action-ack',id:socket.sent.at(-1).id});
  }
  assert.equal(socket.sent.length,4);
});

test('shortcut feedback waits for acknowledgement and blocks rapid repeated clicks',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  const button=page.actions.get('enter');button.listeners.click();
  const frame=socket.sent.at(-1);assert(frame.id);
  button.listeners.click();page.actions.get('down').listeners.click();
  assert.equal(socket.sent.length,1);
  assert(button.disabled);assert(page.elements.get('action-status').textContent.includes('正在发送'));
  socket.message({type:'action-ack',id:'stale'});assert(button.disabled);
  socket.message({type:'action-ack',id:frame.id});assert(!button.disabled);
  assert(page.elements.get('action-status').textContent.includes('已写入终端'));
  button.listeners.click();socket.message({type:'action-error',id:socket.sent.at(-1).id});
  assert(page.elements.get('action-status').textContent.includes('操作失败'));assert(!button.disabled);
});

test('shortcut timeouts and disconnects report uncertain delivery without retrying',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  page.actions.get('approve').listeners.click();
  page.timers.find(timer=>timer.delay===7000).fn();
  assert.equal(socket.sent.length,1);assert(page.elements.get('action-status').textContent.includes('是否送达未知'));
  page.actions.get('enter').listeners.click();socket.close();
  assert(page.elements.get('action-status').textContent.includes('是否送达未知'));
  assert(page.elements.get('connection-status').textContent.includes('重连'));
  assert(page.actions.get('enter').disabled);
  page.actions.get('enter').listeners.click();assert.equal(socket.sent.length,2);
  assert(page.elements.get('action-status').textContent.includes('未发送'));
});

test('ended terminals disable keys but allow an acknowledged explicit start',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  socket.message({type:'status',running:false});
  assert(page.actions.get('enter').disabled);assert(!page.actions.get('start_codex').disabled);
  page.actions.get('enter').listeners.click();assert.equal(socket.sent.length,0);
  page.actions.get('start_codex').listeners.click();const frame=socket.sent.at(-1);
  socket.message({type:'session-reset',cols:80,rows:24});
  socket.message({type:'status',running:true});
  socket.message({type:'action-ack',id:frame.id});
  assert(!page.actions.get('enter').disabled);
  assert(page.elements.get('action-status').textContent.includes('已写入终端'));
});

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
