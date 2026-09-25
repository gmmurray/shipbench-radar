// The keyboard front end for `--console`, which the desktop launcher uses:
// the window shows the server starting, then single keypresses act on it. It
// never opens a browser tab by itself, since the Radar tab is usually still
// open from last time; `o` opens one on request.

export type KeyAction = 'open' | 'quit' | 'help';

const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

export function keyAction(key: string): KeyAction | null {
  switch (key.toLowerCase()) {
    case 'o':
      return 'open';
    case 'q':
    case CTRL_C:
    case CTRL_D:
      return 'quit';
    case 'h':
    case '?':
      return 'help';
    default:
      return null;
  }
}

export const KEY_HELP = [
  '  o  open Radar in a new browser tab',
  '  q  quit',
].join('\n');

export interface ConsoleHandlers {
  open(): void;
  quit(): void;
  help(): void;
}

/**
 * Read single keypresses from a terminal. Raw mode means Ctrl+C arrives as a
 * key rather than a signal, so it quits through the same path as `q`, and
 * cmd.exe never asks "Terminate batch job?". Returns false, and does
 * nothing, when stdin isn't a terminal.
 */
export function listenForKeys(handlers: ConsoleHandlers): boolean {
  const input = process.stdin;
  if (!input.isTTY) return false;

  input.setRawMode(true);
  input.setEncoding('utf-8');
  input.resume();
  input.on('data', (chunk: string) => {
    for (const key of chunk) {
      const action = keyAction(key);
      if (action) handlers[action]();
    }
  });
  return true;
}

export function stopListening(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}
