/** Strip escape codes and resolve carriage-return redraws (progress bars) in process output. */
export function cleanOutput(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .split('\n')
    .map((line) => line.split('\r').filter(Boolean).pop() ?? '')
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
