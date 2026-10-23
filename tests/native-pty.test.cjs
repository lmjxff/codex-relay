const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {fixture,cleanup}=require('./helpers.cjs');

test('native PTY starts a harmless local command and reports its exit',{timeout:20000},async()=>{
  const directory=fixture();
  try {
    // Windows ConPTY workers can retain the event loop after the shell exits.
    // An isolated owner exits explicitly after verifying output and exit code.
    const script=`
      const pty=require(process.argv[2]);
      const windows=process.platform==='win32';
      const shell=windows?require('node:path').join(process.env.SystemRoot,'System32','cmd.exe'):'/bin/sh';
      const args=windows?['/d','/c','echo relay-native-smoke']:['-c','printf relay-native-smoke'];
      const env={TERM:'xterm-256color'};
      for(const key of ['SystemRoot','WINDIR','COMSPEC','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
      const proc=pty.spawn(shell,args,{cwd:process.argv[1],cols:80,rows:24,env,name:'xterm-256color'});
      let output='';proc.onData(data=>{output+=data;});
      proc.onExit(event=>{const ok=event.exitCode===0&&output.includes('relay-native-smoke');process.stdout.write(ok?'smoke-ok':'smoke-failed',()=>process.exit(ok?0:1));});
      setTimeout(()=>process.exit(2),10000);
    `;
    const {stdout}=await promisify(execFile)(process.execPath,['-e',script,directory,require.resolve('node-pty')],{timeout:15000,windowsHide:true});
    assert.equal(stdout,'smoke-ok');
  } finally { cleanup(directory); }
});
