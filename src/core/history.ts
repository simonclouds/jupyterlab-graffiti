export const FRAME_ARRAYS = [
  'view',
  'selections',
  'contents',
  'drawings',
  'terminals',
  'speaking',
  'skip'
] as const;

export type FrameName = typeof FRAME_ARRAYS[number];

export interface TimedRecord {
  startTime: number;
  endTime?: number;
  [key: string]: unknown;
}

export interface FieldRecord {
  data?: unknown;
  backRef?: number;
  backRefKind?: string;
}

export interface CellContent {
  index: number;
  type?: string;
  contentsRecord: FieldRecord;
  outputsRecord: FieldRecord;
}

export interface ContentsRecord extends TimedRecord {
  cellsContent: { [cellId: string]: CellContent };
  cellsPresentThisFrame: { [cellId: string]: number };
}

export interface History {
  storageCellId?: string;
  recordingStartTime: number;
  duration?: number;
  view: TimedRecord[];
  selections: TimedRecord[];
  contents: ContentsRecord[];
  drawings: TimedRecord[];
  terminals: TimedRecord[];
  speaking: TimedRecord[];
  skip: TimedRecord[];
  lastVisited?: { [name: string]: number };
  cellContentsTracking?: { [cellId: string]: { index: number; data: unknown } };
  cellOutputsTracking?: { [cellId: string]: { index: number; data: unknown } };
  cellAdditions?: { [cellId: string]: unknown };
  affectedCellIds?: { [cellId: string]: boolean };
  processed?: unknown;
  terminalsContents?: unknown;
}

export interface FrameSet {
  view?: TimedRecord;
  selections?: TimedRecord;
  contents?: ContentsRecord;
  contentsIndex?: number;
  drawings?: TimedRecord;
  terminals?: TimedRecord;
  speaking?: TimedRecord;
  skip?: TimedRecord;
}

export function emptyHistory(recordingStartTime: number, storageCellId?: string): History {
  return {
    storageCellId,
    recordingStartTime,
    view: [],
    selections: [],
    contents: [],
    drawings: [],
    terminals: [],
    speaking: [],
    skip: [],
    lastVisited: {
      view: 0,
      selections: 0,
      contents: 0,
      drawings: 0,
      terminals: 0,
      speaking: 0,
      skip: 0
    },
    cellContentsTracking: {},
    cellOutputsTracking: {},
    cellAdditions: {}
  };
}

export function appendRecord(history: History, type: FrameName, record: TimedRecord): void {
  const bucket = history[type] as TimedRecord[];
  bucket.push(record);
}

export function finalizeHistory(history: History, endTime: number): void {
  const start = history.recordingStartTime;
  history.duration = endTime - start;
  for (const name of FRAME_ARRAYS) {
    const records = history[name] as TimedRecord[];
    const last = records.length - 1;
    for (let i = 0; i < records.length; i++) {
      if (records[i].endTime === undefined) {
        records[i].endTime = i === last ? endTime : records[i + 1].startTime;
      }
      records[i].startTime = records[i].startTime - start;
      records[i].endTime = (records[i].endTime as number) - start;
    }
  }
  delete history.cellContentsTracking;
  delete history.cellOutputsTracking;
}

/** Latest record that has already started. A 50ms clock can skip a 1ms window. */
export function recordAt<T extends TimedRecord>(records: T[], time: number): T | undefined {
  let found: T | undefined;
  for (const record of records) {
    if (record.startTime <= time) {
      found = record;
    }
  }
  return found;
}

/** Old takes stored start times far below zero, so playback jumped to the last frame. */
export function normalizeTimeline(history: History): void {
  let earliest = 0;
  for (const name of FRAME_ARRAYS) {
    for (const record of history[name] as TimedRecord[]) {
      if (record.startTime < earliest) {
        earliest = record.startTime;
      }
    }
  }
  if (earliest >= 0) {
    return;
  }
  const shift = -earliest;
  let latest = 0;
  for (const name of FRAME_ARRAYS) {
    for (const record of history[name] as TimedRecord[]) {
      record.startTime += shift;
      if (typeof record.endTime === 'number') {
        record.endTime += shift;
        if (record.endTime > latest) {
          latest = record.endTime;
        }
      }
    }
  }
  if (!history.duration || history.duration < latest) {
    history.duration = latest;
  }
}

export function framesAt(history: History, time: number): FrameSet {
  const contents = recordAt(history.contents, time);
  const contentsIndex = contents ? history.contents.indexOf(contents) : -1;
  return {
    view: recordAt(history.view, time),
    selections: recordAt(history.selections, time),
    contents,
    contentsIndex: contentsIndex >= 0 ? contentsIndex : undefined,
    drawings: recordAt(history.drawings, time),
    terminals: recordAt(history.terminals, time),
    speaking: recordAt(history.speaking, time),
    skip: recordAt(history.skip, time)
  };
}

export function resolveField(
  history: History,
  contentsIndex: number,
  cellId: string,
  record: FieldRecord | undefined,
  kind: 'contents' | 'outputs'
): unknown {
  if (!record) {
    return undefined;
  }
  if (record.data !== undefined && record.data !== null) {
    return record.data;
  }
  if (record.backRef === undefined) {
    return undefined;
  }
  const previous = history.contents[record.backRef];
  if (!previous || !previous.cellsContent[cellId]) {
    return undefined;
  }
  const nested =
    kind === 'contents'
      ? previous.cellsContent[cellId].contentsRecord
      : previous.cellsContent[cellId].outputsRecord;
  return resolveField(history, record.backRef, cellId, nested, kind);
}

/** Classic recordings wrap highlighted source in graffiti-highlight spans. */
export function plainSource(value: string): string {
  if (value.indexOf('<') === -1) {
    return value;
  }
  return value.replace(/<[^>]*>/g, '');
}

export function highlightPhrases(value: string): string[] {
  const phrases: string[] = [];
  const pattern = /graffiti-highlight[^>]*>(?:<i><\/i>)?([^<]*)</g;
  let match = pattern.exec(value);
  while (match) {
    if (match[1]) {
      phrases.push(match[1]);
    }
    match = pattern.exec(value);
  }
  return phrases;
}

export function selectionRange(selection: {
  start?: { line: number; column: number };
  end?: { line: number; column: number };
  anchor?: { line: number; ch: number };
  head?: { line: number; ch: number };
}): { start: { line: number; column: number }; end: { line: number; column: number } } | undefined {
  if (selection.start && selection.end) {
    return { start: selection.start, end: selection.end };
  }
  if (selection.anchor && selection.head) {
    return {
      start: { line: selection.anchor.line, column: selection.anchor.ch },
      end: { line: selection.head.line, column: selection.head.ch }
    };
  }
  return undefined;
}

export function cellTextAt(history: History, time: number, cellId: string): string | undefined {
  const frames = framesAt(history, time);
  if (!frames.contents || frames.contentsIndex === undefined) {
    return undefined;
  }
  const cell = frames.contents.cellsContent[cellId];
  if (!cell) {
    return undefined;
  }
  const data = resolveField(
    history,
    frames.contentsIndex,
    cellId,
    cell.contentsRecord,
    'contents'
  );
  return typeof data === 'string' ? data : undefined;
}

export interface PlayableRecording {
  createDate?: number;
  hasMovie?: boolean;
  activeTakeId?: string;
}

export function latestRecording<T extends PlayableRecording>(
  manifest: { [cellId: string]: { [recordingKey: string]: T } },
  cellId?: string
): { cellId: string; recordingKey: string; recording: T } | undefined {
  const cellIds = cellId ? [cellId] : Object.keys(manifest);
  let best: { cellId: string; recordingKey: string; recording: T } | undefined;
  for (const id of cellIds) {
    const recordings = manifest[id];
    if (!recordings) {
      continue;
    }
    for (const recordingKey of Object.keys(recordings)) {
      const recording = recordings[recordingKey];
      if (!recording.hasMovie || !recording.activeTakeId) {
        continue;
      }
      if (!best || (recording.createDate || 0) >= (best.recording.createDate || 0)) {
        best = { cellId: id, recordingKey, recording };
      }
    }
  }
  return best;
}

export function cellIdsInOrder(frame: ContentsRecord): string[] {
  return Object.keys(frame.cellsContent).sort(
    (a, b) => frame.cellsContent[a].index - frame.cellsContent[b].index
  );
}

export function createBackRef(
  history: History,
  cellId: string,
  kind: 'contents' | 'outputs',
  data: unknown
): FieldRecord {
  const tracking =
    kind === 'contents' ? history.cellContentsTracking : history.cellOutputsTracking;
  if (!tracking) {
    return { data, backRef: undefined, backRefKind: undefined };
  }
  const previous = tracking[cellId];
  if (previous && previous.data === data) {
    return { data: undefined, backRef: previous.index, backRefKind: kind };
  }
  tracking[cellId] = { index: history.contents.length, data };
  return { data, backRef: undefined, backRefKind: undefined };
}
