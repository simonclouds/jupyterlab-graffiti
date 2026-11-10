import { Contents } from '@jupyterlab/services';

import { compressJson, decompressJson } from './core/codec';
import {
  audioPath,
  historyPath,
  manifestPath,
  parentDirectories,
  TakePathParts
} from './core/paths';
import { History } from './core/history';

export interface ManifestRecording {
  cellId: string;
  cellType: string;
  createDate: number;
  inProgress: boolean;
  tokens: { [key: string]: unknown };
  range: { [key: string]: unknown };
  markdown: string;
  authorId: string;
  authorType: string;
  activeTakeId?: string;
  hasMovie: boolean;
  takes?: { [takeId: string]: { duration: number; createDate: number } };
}

export type Manifest = {
  [cellId: string]: { [recordingKey: string]: ManifestRecording };
};

export async function ensureParents(
  contents: Contents.IManager,
  filePath: string
): Promise<void> {
  for (const directory of parentDirectories(filePath)) {
    try {
      await contents.get(directory, { content: false });
    } catch {
      await contents.save(directory, { type: 'directory' } as Contents.IModel);
    }
  }
}

export class GraffitiStore {
  constructor(private contents: Contents.IManager) {}

  get manager(): Contents.IManager {
    return this.contents;
  }

  async readManifest(parts: TakePathParts): Promise<Manifest> {
    const path = manifestPath(parts);
    const raw = await this.read(path);
    if (!raw) {
      return {};
    }
    return decompressJson<Manifest>(raw);
  }

  async writeManifest(parts: TakePathParts, manifest: Manifest): Promise<void> {
    await this.write(manifestPath(parts), compressJson(manifest));
  }

  async readHistory(parts: TakePathParts): Promise<History> {
    const raw = await this.read(historyPath(parts));
    if (!raw) {
      throw new Error('Missing Graffiti history at ' + historyPath(parts));
    }
    return decompressJson<History>(raw);
  }

  async writeHistory(parts: TakePathParts, history: History): Promise<void> {
    await this.write(historyPath(parts), compressJson(history));
  }

  async readAudio(parts: TakePathParts): Promise<string> {
    return (await this.read(audioPath(parts))) || '';
  }

  async writeAudio(parts: TakePathParts, audioBase64: string): Promise<void> {
    await this.write(audioPath(parts), audioBase64);
  }

  findRecording(
    manifest: Manifest,
    recordingId: string
  ): { cellId: string; recordingKey: string; recording: ManifestRecording } | undefined {
    for (const cellId of Object.keys(manifest)) {
      const recordings = manifest[cellId];
      if (recordings[recordingId]) {
        return { cellId, recordingKey: recordingId, recording: recordings[recordingId] };
      }
      for (const recordingKey of Object.keys(recordings)) {
        if (recordingKey === recordingId || recordings[recordingKey].activeTakeId === recordingId) {
          return { cellId, recordingKey, recording: recordings[recordingKey] };
        }
      }
    }
    return undefined;
  }

  private async read(path: string): Promise<string | undefined> {
    try {
      const model = await this.contents.get(path, { content: true });
      return typeof model.content === 'string' ? model.content : undefined;
    } catch {
      return undefined;
    }
  }

  private async write(path: string, content: string): Promise<void> {
    await ensureParents(this.contents, path);
    await this.contents.save(path, {
      type: 'file',
      format: 'text',
      content
    });
  }
}
