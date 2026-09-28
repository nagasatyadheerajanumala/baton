import { PassThrough } from 'node:stream';

export type MouseEvent =
  | { type: 'click'; x: number; y: number; button: 'left' | 'middle' | 'right' }
  | { type: 'wheel'; x: number; y: number; direction: 'up' | 'down' };

// SGR extended mouse reports: ESC [ < button ; x ; y (M = press, m = release)
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;

export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';

export function parseMouse(button: number, x: number, y: number, kind: string): MouseEvent | undefined {
  if (button === 64 || button === 65) return { type: 'wheel', x, y, direction: button === 64 ? 'up' : 'down' };
  if (kind !== 'M' || button & 32) return undefined; // ignore releases and motion
  const b = button & 3;
  return { type: 'click', x, y, button: b === 0 ? 'left' : b === 1 ? 'middle' : 'right' };
}

/** Pull mouse reports out of a chunk of terminal input. Returns remaining text and any trailing partial sequence. */
export function extractMouse(chunk: string, onMouse: (e: MouseEvent) => void): { text: string; carry: string } {
  const text = chunk.replace(SGR_MOUSE, (_m, b: string, x: string, y: string, kind: string) => {
    const e = parseMouse(Number(b), Number(x), Number(y), kind);
    if (e) onMouse(e);
    return '';
  });
  // A bare ESC is a real Escape keypress; only hold back something that looks like the start of a mouse report.
  const partial = PARTIAL.exec(text);
  if (partial && partial[0].startsWith('\x1b[<')) return { text: text.slice(0, partial.index), carry: partial[0] };
  return { text, carry: '' };
}

/**
 * A stdin stand-in for Ink that strips mouse reports before Ink's key parser
 * sees them (otherwise clicks would type garbage into the prompt). Raw-mode
 * and ref counting are forwarded to the real stdin.
 */
export function mouseFilteredStdin(stdin: NodeJS.ReadStream, onMouse: (e: MouseEvent) => void): NodeJS.ReadStream {
  const out = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
  let carry = '';
  Object.assign(out, {
    isTTY: stdin.isTTY,
    setRawMode(mode: boolean) {
      stdin.setRawMode?.(mode);
      return out;
    },
    ref() {
      stdin.ref();
      return out;
    },
    unref() {
      stdin.unref();
      return out;
    },
  });
  stdin.on('data', (buf: Buffer | string) => {
    const r = extractMouse(carry + buf.toString(), onMouse);
    carry = r.carry;
    if (r.text) out.write(r.text);
  });
  return out;
}
