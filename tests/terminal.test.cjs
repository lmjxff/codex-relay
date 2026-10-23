const {test}=require('node:test');
const assert=require('node:assert/strict');
const {attachPtyLifecycle,terminalSize,sharedTerminalSize,normalizePtyExit,ptyExitMessage}=require('../dist/terminal-lifecycle');

test('old PTY events do not affect a replacement session',()=>{
  const old={onData(fn){this.data=fn;},onExit(fn){this.exit=fn;}};
  const replacement={};let current=old;let received=0;let exited=0;
  attachPtyLifecycle(old,()=>current,()=>received++,()=>{current=null;exited++;});
  old.data('current output');assert.equal(received,1);
  current=replacement;old.exit({exitCode:0});old.data('stale output');
  assert(current===replacement && exited===0 && received===1);
});

test('normal, failed and unavailable native exit statuses remain distinct',()=>{
  const missing=normalizePtyExit({exitCode:undefined,signal:undefined});
  assert.deepEqual(missing,{exitCode:null,signal:null,kind:'unknown'});
  assert(ptyExitMessage(missing).includes('did not report'));
  assert(!ptyExitMessage(missing).includes('undefined'));
  assert.equal(normalizePtyExit({exitCode:0}).kind,'normal');
  assert.equal(normalizePtyExit({exitCode:2}).kind,'error');
  assert.equal(normalizePtyExit({signal:15}).kind,'error');
});

test('shared geometry fits the smallest connected viewport without independent grids',()=>{
  assert.deepEqual(sharedTerminalSize([{cols:120,rows:35},{cols:40,rows:12}]),{cols:40,rows:12});
  assert.deepEqual(sharedTerminalSize([],{cols:40,rows:12}),{cols:40,rows:12});
});

test('current PTY exit updates its own session',()=>{
  const proc={onData(){},onExit(fn){this.exit=fn;}};let current=proc;
  attachPtyLifecycle(proc,()=>current,()=>{},()=>{current=null;});
  proc.exit({exitCode:0});assert.equal(current,null);
});

test('terminal sizes are finite and bounded',()=>{
  assert.deepEqual(terminalSize(NaN,Infinity),{cols:80,rows:24});
  assert.deepEqual(terminalSize(-1,10000),{cols:20,rows:120});
});
