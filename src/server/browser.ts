import { spawn } from 'node:child_process';
import { platform } from 'node:process';

/**
 * Open `url` in the default browser. With a browser already running, this
 * opens a new tab in it. Mirrors openBrowser in the CLI's boardServer.ts.
 */
export function openBrowser(url: string): void {
  const command =
    platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
