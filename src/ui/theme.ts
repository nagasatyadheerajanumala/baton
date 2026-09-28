import { Chalk } from 'chalk';

/**
 * One accent, a muted chrome color, and three semantic colors. Everything in
 * the TUI goes through these, so the palette stays coherent. Degrades to 256
 * or 16 colors automatically, and to none with NO_COLOR / non-TTY.
 */
const chalk = new Chalk({ level: process.env.NO_COLOR ? 0 : undefined });

export const palette = {
  fg: '#c0caf5',
  muted: '#565f89',
  rule: '#292e42',
  accent: '#7aa2f7',
  success: '#9ece6a',
  warning: '#e0af68',
  danger: '#f7768e',
  selection: '#283457',
} as const;

export const t = {
  text: (s: string) => s,
  bold: (s: string) => chalk.bold(s),
  muted: (s: string) => chalk.hex(palette.muted)(s),
  rule: (s: string) => chalk.hex(palette.rule)(s),
  accent: (s: string) => chalk.hex(palette.accent)(s),
  success: (s: string) => chalk.hex(palette.success)(s),
  warning: (s: string) => chalk.hex(palette.warning)(s),
  danger: (s: string) => chalk.hex(palette.danger)(s),
  selected: (s: string) => chalk.bgHex(palette.selection)(s),
  inverse: (s: string) => chalk.inverse(s),
};

export const glyph = {
  prompt: '›',
  ok: '✓',
  fail: '✗',
  active: '●',
  idle: '○',
  sep: '·',
  chain: '›',
  switch: '─',
  gear: '⚙',
  wait: '⏳',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};
