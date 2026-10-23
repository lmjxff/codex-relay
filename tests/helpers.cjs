const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const {execFileSync} = require('node:child_process');
const project = path.resolve(__dirname, '..');
const fixtures = new Set();

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-relay-test-'));
  fixtures.add(path.resolve(directory));
  return directory;
}

function cleanup(directory) {
  const absolute = path.resolve(directory);
  if (!fixtures.has(absolute) || path.dirname(absolute) !== path.resolve(os.tmpdir())) throw Error('Unsafe fixture cleanup');
  fs.rmSync(absolute, {recursive:true, force:true, maxRetries:3, retryDelay:100});
  fixtures.delete(absolute);
}

function git(directory, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(directory,'.no-hooks')}`,
    '-C', directory, ...args], {encoding:'utf8', stdio:['ignore','pipe','pipe'], windowsHide:true});
}

function repository(directory) {
  const emptyTemplate = fixture();
  execFileSync('git', ['-c', `init.templateDir=${emptyTemplate}`, 'init','-q','-b','main',directory], {stdio:'pipe',windowsHide:true});
  cleanup(emptyTemplate);
  git(directory,'config','user.name','Relay Regression Tests');
  git(directory,'config','user.email','relay-tests@example.test');
  git(directory,'config','core.quotePath','true');
}

function loadWithMocks(file, mocks, append = '') {
  const filename = path.join(project,'dist',file);
  const original = Module._load;
  Module._load = function(request,parent,isMain) {
    if (parent?.filename === filename && Object.hasOwn(mocks,request)) return mocks[request];
    return original.call(this,request,parent,isMain);
  };
  try {
    const loaded = new Module(filename,module);
    loaded.filename=filename;
    loaded.paths=Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(filename,'utf8')+'\n'+append,filename);
    return loaded.exports;
  } finally { Module._load=original; }
}

module.exports={project,fixture,cleanup,git,repository,loadWithMocks};
