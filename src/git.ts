import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface GitFileStatus {
  code: string;
  file: string;
  staged: boolean;
  untracked: boolean;
  originalFile?: string;
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  return stdout;
}

export function parseGitStatus(output: string): GitFileStatus[] {
  const entries = output.split('\0');
  const files: GitFileStatus[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4 || entry[2] !== ' ') continue;
    const code = entry.slice(0, 2);
    const item: GitFileStatus = {
      code: code.trim() || 'M', file: entry.slice(3),
      staged: code[0] !== ' ' && code[0] !== '?', untracked: code === '??',
    };
    if (/[RC]/.test(code)) item.originalFile = entries[++index] || '';
    files.push(item);
  }
  return files;
}

export async function readGitStatus(cwd: string) {
  const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const [branch, status] = await Promise.all([
    runGit(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => 'HEAD'),
    runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  return { root, branch: branch.trim(), files: parseGitStatus(status) };
}

function quotePath(value: string): string {
  return /[\s"\\]/.test(value) ? JSON.stringify(value) : value;
}

export async function buildUntrackedPatch(root: string, file: string): Promise<{ patch: string; omitted?: string }> {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { patch: '', omitted: 'outside repository' };
  }
  try {
    const stat = await fs.promises.lstat(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) return { patch: '', omitted: 'not a regular file' };
    if (stat.size > 256 * 1024) return { patch: '', omitted: 'preview limited to 256 KiB per untracked file' };
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(await fs.promises.readlink(absolute), 'utf8')
      : await fs.promises.readFile(absolute);
    const from = quotePath(`a/${file}`);
    const to = quotePath(`b/${file}`);
    const header = `diff --git ${from} ${to}\nnew file mode ${stat.isSymbolicLink() ? '120000' : '100644'}\n`;
    const content = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
      return { patch: `${header}Binary files /dev/null and ${to} differ\n` };
    }
    if (!content) return { patch: header };
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const endsWithNewline = lines[lines.length - 1] === '';
    if (endsWithNewline) lines.pop();
    return { patch: `${header}--- /dev/null\n+++ ${to}\n@@ -0,0 +1,${lines.length} @@\n`
      + lines.map(line => `+${line}`).join('\n') + '\n'
      + (endsWithNewline ? '' : '\\ No newline at end of file\n') };
  } catch {
    return { patch: '', omitted: 'file unavailable while reading preview' };
  }
}

export async function readGitDiff(cwd: string, targetFile = '') {
  if (targetFile.includes('\0')) throw new Error('Invalid file path');
  const status = await readGitStatus(cwd);
  const files = status.files.filter(file => !targetFile || file.file === targetFile);
  const hasHead = await runGit(status.root, ['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
  const options = ['--unified=3', '--no-ext-diff', '--no-textconv', '--no-color'];
  const filter = targetFile ? ['--', `:(literal)${targetFile}`] : [];
  let rawDiff = hasHead
    ? await runGit(status.root, ['diff', 'HEAD', ...options, ...filter])
    : (await runGit(status.root, ['diff', '--cached', ...options, ...filter]))
      + (await runGit(status.root, ['diff', ...options, ...filter]));
  const omittedFiles: { file: string; reason: string }[] = [];
  for (const file of files.filter(item => item.untracked)) {
    const result = await buildUntrackedPatch(status.root, file.file);
    if (result.patch) rawDiff += (rawDiff && !rawDiff.endsWith('\n') ? '\n' : '') + result.patch;
    if (result.omitted) omittedFiles.push({ file: file.file, reason: result.omitted });
  }
  return { rawDiff, hasChanges: files.length > 0, omittedFiles, repoRoot: status.root };
}
