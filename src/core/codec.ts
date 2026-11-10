import * as LZString from 'lz-string';

/**
 * Classic Graffiti writes LZString.compressToBase64 output.
 * `%%writefile` inserts newlines into the temporary `.cr` file; the file
 * that playback fetches (`history.txt`, `manifest.json`) has those newlines
 * removed. Accept both forms.
 */
export function compressText(value: string): string {
  return LZString.compressToBase64(value);
}

export function decompressText(payload: string): string {
  const stripped = payload.replace(/[\r\n]/g, '');
  const decoded = LZString.decompressFromBase64(stripped);
  if (decoded === null || decoded === '') {
    throw new Error('Graffiti payload is not LZString base64');
  }
  return decoded;
}

export function compressJson(value: unknown): string {
  return compressText(JSON.stringify(value));
}

export function decompressJson<T>(payload: string): T {
  return JSON.parse(decompressText(payload)) as T;
}
