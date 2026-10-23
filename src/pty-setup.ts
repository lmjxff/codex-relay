import fs from 'fs';
import path from 'path';

export function preparePtyRuntime(): void {
  if (process.platform !== 'darwin') return;
  // node-pty 1.1.0's macOS prebuilds omit the helper's execute bits:
  // https://github.com/microsoft/node-pty/issues/919
  // Limit the workaround to known helper files inside the installed dependency.
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${process.arch}`]) {
    const helper = path.join(root, directory, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    const stat = fs.lstatSync(helper);
    if (!stat.isFile()) throw new Error('Invalid node-pty spawn helper. Reinstall dependencies.');
    if ((stat.mode & 0o111) !== 0o111) fs.chmodSync(helper, stat.mode | 0o111);
  }
}
