import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as Diff2Html from 'diff2html';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 3210);
const HOST = process.env.HOST || '0.0.0.0';
const TARGET_CWD = path.resolve(process.env.CODEX_CWD || process.cwd());

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

export interface GitFileStatus {
  code: string;
  file: string;
  staged: boolean;
  untracked: boolean;
}

async function runGit(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: TARGET_CWD,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (typeof err?.stdout === 'string' && err.stdout.length > 0) {
      return err.stdout;
    }
    throw err;
  }
}

async function buildUntrackedPatch(relPath: string): Promise<string> {
  try {
    const absPath = path.resolve(TARGET_CWD, relPath);
    if (!absPath.startsWith(TARGET_CWD)) return '';
    const stat = await fs.promises.stat(absPath);
    if (!stat.isFile() || stat.size > 256 * 1024) return '';
    const content = await fs.promises.readFile(absPath, 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const body = lines.map((line) => `+${line}`).join('\n');
    return [
      `diff --git a/${relPath} b/${relPath}`,
      `new file mode 100644`,
      `--- /dev/null`,
      `+++ b/${relPath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      body,
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

app.get('/api/git/status', async (_req: Request, res: Response) => {
  try {
    const branchOut = await runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const statusOut = await runGit(['status', '--porcelain=v1']);
    const files: GitFileStatus[] = statusOut
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        return {
          code: code.trim() || 'M',
          file,
          staged: code[0] !== ' ' && code[0] !== '?',
          untracked: code === '??',
        };
      });

    res.json({
      ok: true,
      cwd: TARGET_CWD,
      branch: branchOut.trim(),
      files,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to read git status',
    });
  }
});

app.get('/api/git/diff', async (req: Request, res: Response) => {
  try {
    const targetFile = typeof req.query.file === 'string' ? req.query.file.trim() : '';
    const hasHead = await runGit(['rev-parse', '--verify', 'HEAD'])
      .then(() => true)
      .catch(() => false);

    const diffArgs = hasHead ? ['diff', 'HEAD', '--unified=3'] : ['diff', '--unified=3'];
    if (targetFile) {
      diffArgs.push('--', targetFile);
    }

    let rawDiff = await runGit(diffArgs);

    if (!rawDiff.trim()) {
      const stagedArgs = ['diff', '--cached', '--unified=3'];
      if (targetFile) stagedArgs.push('--', targetFile);
      rawDiff = await runGit(stagedArgs);
    }

    const statusOut = await runGit(['status', '--porcelain=v1']);
    const untrackedFiles = statusOut
      .split(/\r?\n/)
      .filter((l) => l.startsWith('?? '))
      .map((l) => l.slice(3).trim())
      .filter((f) => !targetFile || f === targetFile);

    for (const untracked of untrackedFiles) {
      const patch = await buildUntrackedPatch(untracked);
      if (patch) {
        rawDiff += (rawDiff.endsWith('\n') || !rawDiff ? '' : '\n') + patch;
      }
    }

    const html = rawDiff.trim()
      ? Diff2Html.html(rawDiff, {
          drawFileList: true,
          matching: 'lines',
          outputFormat: 'line-by-line',
        })
      : '';

    res.json({
      ok: true,
      cwd: TARGET_CWD,
      file: targetFile || null,
      rawDiff,
      html,
      hasChanges: Boolean(rawDiff.trim()),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({
      ok: false,
      error: error?.message || 'Failed to generate git diff',
    });
  }
});

export const server = http.createServer(app);
