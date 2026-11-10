/** Same id shape as classic Jupyter Graffiti: `id_` plus 7 base36 chars. */
export function generateUniqueId(): string {
  return 'id_' + Math.random().toString(36).substr(2, 7);
}

export function nowMs(): number {
  return new Date().getTime();
}
