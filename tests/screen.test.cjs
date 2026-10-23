const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Terminal}=require('@xterm/headless');
const {TerminalScreen}=require('../dist/terminal-screen');

function write(terminal,data){return new Promise(resolve=>terminal.write(data,resolve));}
function text(terminal){
  const buffer=terminal.buffer.active,lines=[];
  for(let row=0;row<buffer.length;row++)lines.push(buffer.getLine(row).translateToString(true));
  return lines.join('\n');
}

test('phone and desktop snapshots agree after an ANSI approval redraw and mixed-size connection',async()=>{
  const screen=new TerminalScreen(120,35),desktop=new Terminal({cols:120,rows:35,allowProposedApi:true}),phone=new Terminal({cols:40,rows:12,allowProposedApi:true});
  try{
    await screen.write('\x1b[2J\x1b[HPermission needed\r\n1. Yes, proceed\r\n2. No\r\nPress Enter to confirm',()=>{});
    let snapshot;
    await screen.resize(40,12,result=>{snapshot=result;});
    for(const viewer of [desktop,phone]){viewer.reset();viewer.resize(snapshot.cols,snapshot.rows);await write(viewer,snapshot.data);}
    const redraw='\x1b[H\x1b[2JWorking: the operation was confirmed\r\n';
    await screen.write(redraw,()=>{});
    for(const viewer of [desktop,phone])await write(viewer,redraw);
    assert.equal(text(desktop),text(phone));assert(!text(desktop).includes('Yes, proceed'));
    assert(text(desktop).includes('operation was confirmed'));
    // A fresh viewer gets the current screen, not a raw tail of old ANSI bytes.
    await screen.snapshot(result=>{snapshot=result;});
    phone.reset();phone.resize(snapshot.cols,snapshot.rows);await write(phone,snapshot.data);
    assert.equal(text(desktop),text(phone));
  }finally{await screen.dispose();desktop.dispose();phone.dispose();}
});

test('snapshot and resize barriers preserve pending output order and alternate screens',async()=>{
  const screen=new TerminalScreen(80,24),viewer=new Terminal({cols:40,rows:12,allowProposedApi:true});
  try{
    const order=[];
    const first=screen.write('normal history\r\n\x1b[?1049h\x1b[HApproval screen',()=>order.push('first'));
    const resized=screen.resize(40,12,()=>order.push('resize'));
    const second=screen.write('\x1b[H\x1b[2JApproved\r\n',()=>order.push('second'));
    let snapshot;const barrier=screen.snapshot(result=>{snapshot=result;order.push('snapshot');});
    await Promise.all([first,resized,second,barrier]);
    assert.deepEqual(order,['first','resize','second','snapshot']);
    await write(viewer,snapshot.data);
    assert.equal(viewer.buffer.active.type,'alternate');
    assert(text(viewer).includes('Approved'));assert(!text(viewer).includes('Approval screen'));
  }finally{await screen.dispose();viewer.dispose();}
});

test('a restored screen preserves wrapped Chinese text and cursor position after resizing',async()=>{
  const screen=new TerminalScreen(80,24),live=new Terminal({cols:80,rows:24,allowProposedApi:true,convertEol:true}),restored=new Terminal({cols:40,rows:12,allowProposedApi:true,convertEol:true});
  try{
    const data='\x1b[32m正在等待确认：\x1b[0m'+('中文路径 / some text '.repeat(12))+'\r\n1. Yes, proceed\r\n';
    await screen.write(data,()=>{});await write(live,data);
    await screen.resize(40,12,()=>{});live.resize(40,12);
    let snapshot;await screen.snapshot(result=>{snapshot=result;});await write(restored,snapshot.data);
    assert.equal(text(live),text(restored));
    assert.equal(live.buffer.active.cursorX,restored.buffer.active.cursorX);
    assert.equal(live.buffer.active.cursorY,restored.buffer.active.cursorY);
    const redraw='\x1b[1A\r\x1b[JWorking\r\n';
    await write(live,redraw);await write(restored,redraw);
    assert.equal(text(live),text(restored));assert(!text(live).includes('Yes, proceed'));
  }finally{await screen.dispose();live.dispose();restored.dispose();}
});
