export const DEFAULT_DATA_DIR = 'jupytergraffiti_data/';

export interface TakePathParts {
  notebookDirectory: string;
  notebookId: string;
  authorId: string;
  recordingCellId: string;
  recordingKey: string;
  takeId: string;
  dataDir?: string;
}

export function notebookDirectory(notebookPath: string): string {
  const slash = notebookPath.lastIndexOf('/');
  return slash === -1 ? '' : notebookPath.slice(0, slash);
}

export function parentDirectories(filePath: string): string[] {
  const parts = filePath.split('/').filter(part => part.length > 0);
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

export function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter(part => part !== undefined && part !== '')
    .map((part, index) =>
      index === 0 ? part.replace(/\/+$/g, '') : part.replace(/^\/+|\/+$/g, '')
    )
    .filter(part => part !== '');
  return cleaned.join('/');
}

export function authorBase(parts: {
  notebookDirectory: string;
  notebookId: string;
  authorId: string;
  dataDir?: string;
}): string {
  let dataDir = parts.dataDir || DEFAULT_DATA_DIR;
  if (!dataDir.endsWith('/')) {
    dataDir += '/';
  }
  return joinPath(
    parts.notebookDirectory,
    dataDir,
    'notebooks',
    parts.notebookId,
    'authors',
    parts.authorId
  );
}

export function manifestPath(parts: {
  notebookDirectory: string;
  notebookId: string;
  authorId: string;
  dataDir?: string;
}): string {
  return joinPath(authorBase(parts), 'manifest.json');
}

export function historyPath(parts: TakePathParts): string {
  return joinPath(
    authorBase(parts),
    'cells',
    parts.recordingCellId,
    'graffitis',
    parts.recordingKey,
    'takes',
    parts.takeId,
    'history.txt'
  );
}

export function audioPath(parts: TakePathParts): string {
  return joinPath(
    authorBase(parts),
    'cells',
    parts.recordingCellId,
    'graffitis',
    parts.recordingKey,
    'takes',
    parts.takeId,
    'audio.txt'
  );
}
