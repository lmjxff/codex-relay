const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture,cleanup,git,repository}=require('./helpers.cjs');
const {parseGitStatus,readGitStatus,readGitDiff,buildUntrackedPatch}=require('../dist/git');

test('NUL parser preserves spaces, unicode, newlines and rename source paths',()=>{
  const files=parseGitStatus('?? 新 文件.txt\0R  new -> name.txt\0old name.txt\0 M line\nbreak.txt\0');
  assert.deepEqual(files.map(item=>item.file),['新 文件.txt','new -> name.txt','line\nbreak.txt']);
  assert.equal(files[1].originalFile,'old name.txt');
  assert(files[1].staged);
});

test('new directories, Chinese names and exact file filtering appear in the preview',async()=>{
  const directory=fixture();
  try {
    repository(directory);
    fs.mkdirSync(path.join(directory,'newdir'));
    fs.writeFileSync(path.join(directory,'newdir','新 文件.txt'),'synthetic nested content\n');
    const status=await readGitStatus(directory);
    assert.deepEqual(status.files.map(item=>item.file),['newdir/新 文件.txt']);
    const diff=await readGitDiff(directory,'newdir/新 文件.txt');
    assert(diff.hasChanges && diff.rawDiff.includes('+synthetic nested content'));
    assert.equal(diff.omittedFiles.length,0);
  } finally {cleanup(directory);}
});

test('working from a subdirectory still resolves repository-root paths',async()=>{
  const directory=fixture();
  try {
    repository(directory);
    fs.mkdirSync(path.join(directory,'sub'));
    fs.writeFileSync(path.join(directory,'root.txt'),'root content\n');
    const diff=await readGitDiff(path.join(directory,'sub'));
    assert(diff.rawDiff.includes('+root content'));
  } finally {cleanup(directory);}
});

test('tracked staged changes and renames have previews',async()=>{
  const directory=fixture();
  try {
    repository(directory);
    fs.writeFileSync(path.join(directory,'original.txt'),'old\n');
    git(directory,'add','.');git(directory,'commit','-qm','synthetic baseline');
    git(directory,'mv','original.txt','new name.txt');
    fs.writeFileSync(path.join(directory,'new name.txt'),'updated\n');
    git(directory,'add','.');
    const diff=await readGitDiff(directory);
    assert(diff.hasChanges && diff.rawDiff.includes('+updated'));
  } finally {cleanup(directory);}
});

test('an unborn repository includes staged and unstaged changes together',async()=>{
  const directory=fixture();
  try {
    repository(directory);
    fs.writeFileSync(path.join(directory,'first.txt'),'staged content\n');
    git(directory,'add','.');
    fs.writeFileSync(path.join(directory,'first.txt'),'working content\n');
    const diff=await readGitDiff(directory);
    assert(diff.rawDiff.includes('+staged content') && diff.rawDiff.includes('+working content'));
  } finally {cleanup(directory);}
});

test('large, binary and empty new files are not called a clean working tree',async()=>{
  const directory=fixture();
  try {
    repository(directory);
    fs.writeFileSync(path.join(directory,'large.txt'),'x'.repeat(256*1024+1));
    fs.writeFileSync(path.join(directory,'binary.bin'),Buffer.from([0,1,2]));
    fs.writeFileSync(path.join(directory,'empty.txt'),'');
    const diff=await readGitDiff(directory);
    assert(diff.hasChanges && diff.omittedFiles.some(item=>item.file==='large.txt'));
    assert(diff.rawDiff.includes('Binary files') && diff.rawDiff.includes('empty.txt'));
  } finally {cleanup(directory);}
});

test('preview containment rejects a sibling path',async()=>{
  const directory=fixture();
  try { const result=await buildUntrackedPatch(directory,'../outside.txt');assert(result.omitted && !result.patch); }
  finally {cleanup(directory);}
});
