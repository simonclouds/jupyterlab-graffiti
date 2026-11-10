import { Dialog, showDialog } from '@jupyterlab/apputils';
import { NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { Cell, CodeCell, MarkdownCell } from '@jupyterlab/cells';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { KernelMessage } from '@jupyterlab/services';
import { AudioCapture, AudioPlayback } from './audio';
import { PlaybackClock } from './core/clock';
import {
  appendRecord,
  cellIdsInOrder,
  cellTextAt,
  ContentsRecord,
  createBackRef,
  emptyHistory,
  finalizeHistory,
  framesAt,
  highlightPhrases,
  History,
  latestRecording,
  normalizeTimeline,
  plainSource,
  resolveField,
  TimedRecord
} from './core/history';
import { generateUniqueId, nowMs } from './core/ids';
import { notebookDirectory, TakePathParts } from './core/paths';
import { GraffitiStore, Manifest, ManifestRecording } from './storage';

const COMM_TARGET = 'jupyterlab-graffiti';

interface NotebookMeta {
  id: string;
  language: string;
  firstAuthorId: string;
}

interface TerminalLine {
  text: string;
  kind: 'in' | 'out';
  startTime: number;
}

export class GraffitiSession {
  private manifest: Manifest = {};
  private history: History | undefined;
  private recordingKey = '';
  private recordingCellId = '';
  private takeId = '';
  private cleanups: Array<() => void> = [];
  private recordingCleanups: Array<() => void> = [];
  private clock: PlaybackClock | undefined;
  private timer = 0;
  private audioCapture = new AudioCapture();
  private audioPlay = new AudioPlayback();
  private audioBase64 = '';
  private muted = false;
  private drawing = false;
  private stroke: Array<{ x: number; y: number }> = [];
  private terminalLines: TerminalLine[] = [];
  private access: 'create' | 'view' = 'create';
  private watchedCells = new Set<string>();
  private appliedContents: ContentsRecord | undefined;
  private appliedSelection: TimedRecord | undefined;
  private appliedTerminal: TimedRecord | undefined;
  private appliedDrawing: TimedRecord | undefined;
  private appliedNotes = new Map<string, string>();
  private createdCells = new Set<string>();
  private scrubbing = false;
  private activity = 'idle';
  private recording = false;
  private activated = false;
  private editorShown = false;
  private skipping = false;
  private penMode: 'pen' | 'highlight' | 'eraser' = 'pen';
  private penColor = '#ff0000';
  private temporaryInk = true;
  private altDownAt = 0;
  private recordingStartedAt = 0;
  private snapshot: Array<{ id: string; text: string }> = [];
  private labelSetter: (text: string) => void = () => undefined;
  private bar: HTMLElement;
  private canvas: HTMLCanvasElement;
  private terminalOut: HTMLElement;
  private status: HTMLElement;

  constructor(private panel: NotebookPanel, private store: GraffitiStore) {
    this.bar = document.createElement('div');
    this.bar.className = 'jp-graffiti-panel jp-graffiti-hidden';
    this.bar.dataset.activity = 'idle';
    this.bar.innerHTML = PANEL_HTML;
    this.terminalOut = this.bar.querySelector('.jp-graffiti-terminal-out') as HTMLElement;
    this.status = this.bar.querySelector('.jp-graffiti-status') as HTMLElement;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'jp-graffiti-overlay';
    this.panel.node.appendChild(this.bar);
    this.panel.node.appendChild(this.canvas);
    this.bindUi();
    this.bindKernel();
    void this.panel.context.ready.then(() => this.bootstrap());
  }

  dispose(): void {
    this.stopTimer();
    this.recordingCleanups.splice(0).forEach(cleanup => cleanup());
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.panel.node.removeEventListener('pointerdown', this.onNotebookPointer, true);
    this.bar.remove();
    this.canvas.remove();
  }

  setToolbar(updateLabel: (text: string) => void): void {
    this.labelSetter = updateLabel;
    this.notifyToolbar();
  }

  toggleFromToolbar(): void {
    if (!this.activated) {
      void this.confirmActivate();
      return;
    }
    this.editorShown = !this.editorShown;
    this.present();
    this.notifyToolbar();
  }

  async playRecordingById(recordingId: string): Promise<void> {
    const found = this.store.findRecording(this.manifest, recordingId);
    if (!found || !found.recording.activeTakeId) {
      this.setStatus('No recording ' + recordingId);
      return;
    }
    await this.playTake(found.cellId, found.recordingKey, found.recording.activeTakeId);
  }

  stopPlayback(restore = false): void {
    this.haltClock();
    this.audioPlay.stop();
    this.clock = undefined;
    this.clearNotes();
    this.clearOverlay();
    if (restore) {
      this.restoreSnapshot();
    }
    this.showActivity('idle');
    this.setStatus('stopped');
    this.refreshIdle();
  }

  setAccessLevel(level: string): void {
    this.access = level === 'view' ? 'view' : 'create';
    const record = this.bar.querySelector('.jp-graffiti-record') as HTMLButtonElement;
    record.disabled = this.access === 'view';
  }

  async transferGraffiti(): Promise<void> {
    const meta = this.meta();
    const oldId = meta.id;
    meta.id = generateUniqueId();
    this.writeMeta(meta);
    const directory = notebookDirectory(this.panel.context.path);
    const from = directory
      ? directory + '/jupytergraffiti_data/notebooks/' + oldId
      : 'jupytergraffiti_data/notebooks/' + oldId;
    const to = directory
      ? directory + '/jupytergraffiti_data/notebooks/' + meta.id
      : 'jupytergraffiti_data/notebooks/' + meta.id;
    await this.copyTree(from, to);
    await this.panel.context.save();
    await this.bootstrap();
    this.setStatus('transferred');
  }

  private bindUi(): void {
    this.on(this.bar, '.jp-graffiti-record', () => this.beginPending());
    this.on(this.bar, '.jp-graffiti-rerecord', () => this.beginPending());
    this.on(this.bar, '.jp-graffiti-stop', () => void this.stopRecording());
    this.on(this.bar, '.jp-graffiti-cancel', () => this.cancelRecording());
    this.on(this.bar, '.jp-graffiti-play', () => this.resumeOrPlay());
    this.on(this.bar, '.jp-graffiti-pause', () => this.pause());
    this.on(this.bar, '.jp-graffiti-speed', () => this.toggleSpeed());
    this.on(this.bar, '.jp-graffiti-mute', () => this.toggleMute());
    this.on(this.bar, '.jp-graffiti-draw', () => this.toggleDraw());
    this.on(this.bar, '.jp-graffiti-pen', () => this.choosePen('pen'));
    this.on(this.bar, '.jp-graffiti-highlight', () => this.choosePen('highlight'));
    this.on(this.bar, '.jp-graffiti-eraser', () => this.choosePen('eraser'));
    this.on(this.bar, '.jp-graffiti-exit', () => this.stopPlayback(true));
    this.on(this.bar, '.jp-graffiti-cleanup', () => void this.cleanupTakes());
    this.on(this.bar, '.jp-graffiti-remove', () => void this.removeActive());
    this.on(this.bar, '.jp-graffiti-skip-back', () => this.skip(-5000));
    this.on(this.bar, '.jp-graffiti-skip-forward', () => this.skip(5000));
    this.bar.querySelectorAll('.jp-graffiti-color').forEach(node => {
      node.addEventListener('click', () => {
        this.penColor = '#' + (node as HTMLElement).dataset.color;
        this.markColor();
      });
    });
    const ink = this.bar.querySelector('.jp-graffiti-ink input') as HTMLInputElement;
    ink.addEventListener('change', () => {
      this.temporaryInk = ink.checked;
    });
    const scrub = this.bar.querySelector('.jp-graffiti-scrub') as HTMLInputElement;
    scrub.addEventListener('input', () => {
      if (!this.clock || this.scrubbing) {
        return;
      }
      this.clock.seek(Number(scrub.value));
      this.audioPlay.seek(this.clock.time);
      this.renderFrame();
    });
    const input = this.bar.querySelector('.jp-graffiti-terminal-in') as HTMLInputElement;
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        void this.runTerminal(input.value);
        input.value = '';
      }
    });
    const drag = this.bar.querySelector('.jp-graffiti-drag') as HTMLElement;
    this.dragFrom(drag);
    this.dragFrom(this.bar.querySelector('.jp-graffiti-title') as HTMLElement);
    this.canvas.addEventListener('pointerdown', event => this.penDown(event));
    this.canvas.addEventListener('pointermove', event => this.penMove(event));
    window.addEventListener('pointerup', () => this.penUp());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.panel.node.addEventListener('pointerdown', this.onNotebookPointer, true);
    this.markColor();
  }

  private bindKernel(): void {
    const refresh = (): void => {
      const kernel = this.panel.sessionContext.session?.kernel;
      if (!kernel) {
        return;
      }
      kernel.registerCommTarget(COMM_TARGET, (comm, msg) => {
        comm.onMsg = (incoming: KernelMessage.ICommMsgMsg) => {
          const data = incoming.content.data as { [key: string]: string };
          void this.onComm(data);
        };
        const openData = msg.content.data as { [key: string]: string };
        if (openData && openData.command) {
          void this.onComm(openData);
        }
      });
    };
    this.track(this.panel.sessionContext.kernelChanged, refresh);
    refresh();
  }

  private track(
    signal: {
      connect: (slot: (...args: any[]) => void, thisArg?: unknown) => boolean;
      disconnect: (slot: (...args: any[]) => void, thisArg?: unknown) => boolean;
    },
    slot: (...args: any[]) => void,
    recording = false
  ): void {
    signal.connect(slot, this);
    const cleanup = (): void => {
      signal.disconnect(slot, this);
    };
    (recording ? this.recordingCleanups : this.cleanups).push(cleanup);
  }

  private async onComm(data: { [key: string]: string }): Promise<void> {
    if (data.command === 'play') {
      await this.playRecordingById(data.recordingId);
    } else if (data.command === 'stop') {
      this.stopPlayback();
    } else if (data.command === 'access') {
      this.setAccessLevel(data.level);
    } else if (data.command === 'transfer') {
      await this.transferGraffiti();
    }
  }

  private async bootstrap(): Promise<void> {
    const existing = this.readMeta();
    this.activated = Boolean(existing);
    if (existing) {
      try {
        this.manifest = await this.store.readManifest(this.parts(existing, 'id_unused', 'id_unused'));
      } catch {
        this.manifest = {};
      }
      this.refreshMarkers();
    }
    this.refreshIdle();
    this.setStatus('ready');
    this.notifyToolbar();
    this.track(this.panel.content.activeCellChanged, () => {
      if (this.activity === 'idle') {
        this.refreshIdle();
      }
    });
    const api = ((window as unknown) as { GraffitiLab?: Record<string, unknown> });
    api.GraffitiLab = {
      playRecordingById: (id: string) => this.playRecordingById(id),
      stopPlayback: () => this.stopPlayback(),
      setAccessLevel: (level: string) => this.setAccessLevel(level),
      transferGraffiti: () => this.transferGraffiti()
    };
  }

  private async startRecording(): Promise<void> {
    if (this.access === 'view' || !this.activated || this.recording) {
      return;
    }
    this.recording = true;
    this.haltClock();
    this.clock = undefined;
    this.clearNotes();
    this.clearOverlay();
    this.history = undefined;
    this.showActivity('recording');
    this.setStatus('recording');
    this.watchedCells.clear();
    this.ensureCellIds();
    const meta = this.meta();
    const cell = this.panel.content.activeCell || this.panel.content.widgets[0];
    this.recordingCellId = this.cellId(cell);
    this.recordingKey = generateUniqueId();
    this.takeId = generateUniqueId();
    const recording: ManifestRecording = {
      cellId: this.recordingCellId,
      cellType: cell.model.type,
      createDate: nowMs(),
      inProgress: true,
      tokens: {},
      range: {},
      markdown: 'Graffiti',
      authorId: meta.firstAuthorId,
      authorType: 'creator',
      activeTakeId: this.takeId,
      hasMovie: false,
      takes: {}
    };
    if (!this.manifest[this.recordingCellId]) {
      this.manifest[this.recordingCellId] = {};
    }
    this.manifest[this.recordingCellId][this.recordingKey] = recording;
    this.history = emptyHistory(nowMs(), this.recordingCellId);
    this.terminalLines = [];
    this.captureContents();
    this.captureSelections();
    this.captureView('scroll');
    this.track(this.panel.content.activeCellChanged, () => {
      this.captureSelections();
      this.captureView('focus');
    }, true);
    this.panel.content.widgets.forEach(widget => this.watchCell(widget));
    const cells = this.panel.content.model?.cells;
    if (cells) {
      this.track(
        cells.changed,
        () => {
          this.panel.content.widgets.forEach(widget => this.watchCell(widget));
          this.captureContents();
        },
        true
      );
    }
    this.track(
      NotebookActions.executed,
      (_, args) => {
        if (args.notebook === this.panel.content) {
          this.captureContents();
        }
      },
      true
    );
    this.panel.node.addEventListener('scroll', this.onScroll, true);
    const sample = window.setInterval(() => this.captureContents(), 300);
    this.recordingCleanups.push(() => window.clearInterval(sample));
    this.recordingStartedAt = nowMs();
    const clock = window.setInterval(() => {
      const node = this.bar.querySelector('.jp-graffiti-rec-time');
      if (node) {
        node.textContent = this.skipping ? '--:--' : formatClock(nowMs() - this.recordingStartedAt);
      }
    }, 200);
    this.recordingCleanups.push(() => window.clearInterval(clock));
    const mic = await this.audioCapture.start();
    if (!this.recording) {
      void this.audioCapture.stop();
      return;
    }
    if (mic.result === 'insecure') {
      this.setMessage('The browser blocks the microphone on this http address.');
    } else if (mic.result !== 'ok') {
      this.setMessage("Please grant access to your browser's microphone.");
    } else if (mic.label) {
      this.setMessage('Recording from ' + mic.label + '. Hold the option key down to end recording.');
    }
  }

  private onScroll = (event: Event): void => {
    if (this.clock || !this.history) {
      return;
    }
    const target = event.target as HTMLElement;
    if (!target || this.bar.contains(target) || typeof target.scrollTop !== 'number') {
      return;
    }
    this.captureView('scroll', target.scrollTop);
  };

  private watchCell(widget: Cell): void {
    const id = this.cellId(widget);
    if (this.watchedCells.has(id)) {
      return;
    }
    this.watchedCells.add(id);
    this.track(widget.model.contentChanged, () => this.captureContents(), true);
    if (widget.model.type === 'code') {
      this.track((widget as CodeCell).outputArea.model.changed, () => this.captureContents(), true);
    }
  }

  private async stopRecording(): Promise<void> {
    if (!this.history) {
      return;
    }
    this.recordingCleanups.splice(0).forEach(cleanup => cleanup());
    this.panel.node.removeEventListener('scroll', this.onScroll, true);
    this.clearOverlay();
    this.audioBase64 = await this.audioCapture.stop();
    const history = this.history;
    finalizeHistory(history, nowMs());
    const meta = this.meta();
    const parts = this.parts(meta, this.recordingCellId, this.recordingKey);
    await this.store.writeHistory(parts, history);
    await this.store.writeAudio(parts, this.audioBase64);
    const recording = this.manifest[this.recordingCellId][this.recordingKey];
    recording.inProgress = false;
    recording.hasMovie = true;
    recording.activeTakeId = this.takeId;
    recording.takes = recording.takes || {};
    recording.takes[this.takeId] = {
      duration: history.duration || 0,
      createDate: nowMs()
    };
    await this.store.writeManifest(parts, this.manifest);
    await this.panel.context.save();
    this.history = undefined;
    this.recording = false;
    this.skipping = false;
    this.bar.classList.remove('is-skipping');
    this.refreshMarkers();
    this.showActivity('idle');
    this.refreshIdle();
    this.setStatus('saved ' + (history.duration || 0) + 'ms');
  }

  private async playActive(): Promise<void> {
    const found = latestRecording(this.manifest);
    if (!found || !found.recording.activeTakeId) {
      this.setStatus('nothing to play');
      return;
    }
    await this.playTake(found.cellId, found.recordingKey, found.recording.activeTakeId);
  }

  private async playTake(cellId: string, recordingKey: string, takeId: string): Promise<void> {
    this.audioPlay.arm();
    const meta = this.meta();
    const parts = this.parts(meta, cellId, recordingKey);
    parts.takeId = takeId;
    const history = await this.store.readHistory(parts);
    normalizeTimeline(history);
    this.audioBase64 = await this.store.readAudio(parts);
    this.history = history;
    this.resetApplied();
    this.snapshot = this.panel.content.widgets.map(cell => ({
      id: this.cellId(cell),
      text: cell.model.value.text
    }));
    this.panel.content.mode = 'command';
    this.clock = new PlaybackClock(history.duration || 0);
    this.clock.play();
    const scrub = this.bar.querySelector('.jp-graffiti-scrub') as HTMLInputElement;
    scrub.max = String(this.clock.duration);
    this.audioPlay.load(this.audioBase64);
    this.audioPlay.play(0, this.clock.speed, this.muted);
    this.showActivity('playing');
    this.renderFrame();
    this.armTimer();
    this.setStatus('playing');
  }

  private armTimer(): void {
    this.stopTimer();
    let last = nowMs();
    this.timer = window.setInterval(() => {
      if (!this.clock) {
        return;
      }
      const current = nowMs();
      this.clock.tick(current - last);
      last = current;
      this.renderFrame();
      if (!this.clock.playing) {
        this.audioPlay.pause();
        this.stopTimer();
        if (this.clock.time >= this.clock.duration) {
          this.clearOverlay();
        }
        if (this.activity === 'playing') {
          this.showActivity('playbackPaused');
          this.setStatus('paused');
        }
      }
    }, 50);
  }

  private haltClock(): void {
    if (this.clock) {
      this.clock.pause();
    }
    this.audioPlay.pause();
    this.stopTimer();
  }

  private pause(): void {
    const ended = Boolean(this.clock && this.clock.time >= this.clock.duration);
    this.haltClock();
    this.showActivity('playbackPaused');
    this.setStatus('paused');
    if (ended) {
      this.clearOverlay();
    }
  }

  private toggleSpeed(): void {
    if (!this.clock) {
      return;
    }
    const speed = this.clock.speed === 1 ? 2 : 1;
    this.clock.setSpeed(speed);
    this.audioPlay.setSpeed(speed);
    const button = this.bar.querySelector('.jp-graffiti-speed') as HTMLButtonElement;
    button.textContent = speed + 'x';
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.audioPlay.setMuted(this.muted);
    const button = this.bar.querySelector('.jp-graffiti-mute') as HTMLButtonElement;
    button.textContent = this.muted ? 'Muted' : 'Mute';
  }

  private toggleDraw(): void {
    this.drawing = !this.drawing;
    this.canvas.classList.toggle('jp-graffiti-drawing', this.drawing);
    if (this.drawing) {
      this.placeCanvas();
    }
  }

  private renderFrame(): void {
    if (!this.history || !this.clock) {
      return;
    }
    const time = this.clock.time;
    const frames = framesAt(this.history, time);
    const scrub = this.bar.querySelector('.jp-graffiti-scrub') as HTMLInputElement;
    this.scrubbing = true;
    scrub.value = String(Math.floor(time));
    this.scrubbing = false;
    const label = this.bar.querySelector('.jp-graffiti-play-time');
    if (label) {
      label.textContent = formatClock(time);
    }
    if (frames.contents && frames.contents !== this.appliedContents) {
      this.applyContents(frames.contents, this.history, frames.contentsIndex || 0);
      this.appliedContents = frames.contents;
    }
    if (frames.selections && frames.selections !== this.appliedSelection) {
      this.applySelections(frames.selections);
      this.appliedSelection = frames.selections;
    }
    this.drawFrame(frames.drawings);
    this.appliedDrawing = frames.drawings;
    if (frames.terminals !== this.appliedTerminal) {
      this.renderTerminal(frames.terminals);
      this.appliedTerminal = frames.terminals;
    }
  }

  private resetApplied(): void {
    this.appliedContents = undefined;
    this.appliedSelection = undefined;
    this.appliedTerminal = undefined;
    this.appliedDrawing = undefined;
    this.appliedNotes.clear();
    this.createdCells.clear();
  }

  private applyContents(frame: ContentsRecord, history: History, index: number): void {
    for (const cellId of cellIdsInOrder(frame)) {
      const entry = frame.cellsContent[cellId];
      const cell = this.findCell(cellId) || this.ensurePlaybackCell(cellId, entry.index, entry.type);
      if (!cell) {
        continue;
      }
      const stored = resolveField(history, index, cellId, entry.contentsRecord, 'contents');
      if (typeof stored === 'string') {
        const text = plainSource(stored);
        if (cell.model.value.text !== text) {
          cell.model.value.text = text;
          if (cell.model.type === 'markdown') {
            (cell as MarkdownCell).rendered = false;
          }
          this.reveal(cell);
        }
        const note = highlightPhrases(stored).join(' · ');
        if (this.appliedNotes.get(cellId) !== note) {
          this.appliedNotes.set(cellId, note);
          this.showNotes(cell, note ? note.split(' · ') : []);
        }
      }
      const outputs = resolveField(history, index, cellId, entry.outputsRecord, 'outputs');
      const outputText = typeof outputs === 'string' ? outputs : '';
      const previous = this.appliedNotes.get(cellId + ':out');
      if (previous === outputText || cell.model.type !== 'code') {
        continue;
      }
      this.appliedNotes.set(cellId + ':out', outputText);
      const code = cell as CodeCell;
      code.outputArea.model.clear();
      if (outputText) {
        code.outputArea.model.add({
          output_type: 'display_data',
          data: { 'text/html': outputText, 'text/plain': 'graffiti' },
          metadata: {}
        });
      }
    }
  }

  private ensurePlaybackCell(cellId: string, index: number, type: string | undefined): Cell | undefined {
    if (this.createdCells.has(cellId)) {
      return this.findCell(cellId);
    }
    this.createdCells.add(cellId);
    const model = this.panel.content.model;
    if (!model) {
      return undefined;
    }
    const cellType = type === 'markdown' || type === 'raw' ? type : 'code';
    const at = Math.max(0, Math.min(index, model.cells.length));
    model.sharedModel.insertCell(at, {
      cell_type: cellType,
      source: '',
      metadata: { graffitiCellId: cellId }
    });
    const created = this.findCell(cellId);
    if (created) {
      return created;
    }
    const widget = this.panel.content.widgets[at];
    const existing = widget && (widget.model.metadata.get('graffitiCellId') as string | undefined);
    if (widget && !existing) {
      widget.model.metadata.set('graffitiCellId', cellId);
    }
    return this.findCell(cellId);
  }

  private reveal(cell: Cell): void {
    const notebook = this.panel.content.node;
    const view = notebook.getBoundingClientRect();
    const box = cell.node.getBoundingClientRect();
    if (box.bottom > view.top + 8 && box.top < view.bottom - 8) {
      return;
    }
    cell.node.scrollIntoView({ block: 'nearest' });
  }

  private applySelections(record: TimedRecord): void {
    const cellsSelections = record.cellsSelections as
      | { [id: string]: { active?: boolean; selections?: CodeEditor.IRange[] } }
      | undefined;
    if (!cellsSelections) {
      return;
    }
    for (const cellId of Object.keys(cellsSelections)) {
      const info = cellsSelections[cellId];
      const cell = this.findCell(cellId);
      if (!cell) {
        continue;
      }
      if (info.active) {
        const index = this.panel.content.widgets.indexOf(cell);
        if (index >= 0 && this.panel.content.activeCellIndex !== index) {
          this.panel.content.mode = 'command';
          this.panel.content.activeCellIndex = index;
        }
      }
    }
  }

  private captureContents(): void {
    if (!this.history || this.skipping) {
      return;
    }
    const cellsContent: ContentsRecord['cellsContent'] = {};
    const present: { [id: string]: number } = {};
    this.panel.content.widgets.forEach((cell, index) => {
      const id = this.cellId(cell);
      present[id] = index;
      let outputs = '';
      if (cell.model.type === 'code') {
        outputs = (cell as CodeCell).outputArea.node.innerHTML;
      }
      cellsContent[id] = {
        index,
        type: cell.model.type,
        contentsRecord: createBackRef(this.history as History, id, 'contents', cell.model.value.text),
        outputsRecord: createBackRef(this.history as History, id, 'outputs', outputs)
      };
    });
    const record = {
      startTime: nowMs(),
      cellsContent,
      cellsPresentThisFrame: present
    } as ContentsRecord;
    appendRecord(this.history, 'contents', record);
  }

  private captureSelections(): void {
    if (!this.history) {
      return;
    }
    const cellsSelections: { [id: string]: unknown } = {};
    const active = this.panel.content.activeCell;
    this.panel.content.widgets.forEach((cell, index) => {
      const id = this.cellId(cell);
      let selections: CodeEditor.IRange[] = [];
      if (cell.model.type === 'code' && (cell as CodeCell).editor) {
        const selection = (cell as CodeCell).editor.getSelection();
        selections = [selection];
      }
      cellsSelections[id] = {
        index,
        active: cell === active,
        selections,
        output: { empty: true }
      };
    });
    appendRecord(this.history, 'selections', {
      startTime: nowMs(),
      cellsSelections,
      textSelection: undefined
    });
  }

  private captureView(subType: string, scrollTop?: number): void {
    if (!this.history) {
      return;
    }
    appendRecord(this.history, 'view', {
      startTime: nowMs(),
      subType,
      scrollTop: typeof scrollTop === 'number' ? scrollTop : this.panel.content.node.scrollTop,
      cellId: this.panel.content.activeCell ? this.cellId(this.panel.content.activeCell) : ''
    });
  }

  private async runTerminal(command: string): Promise<void> {
    const line: TerminalLine = { text: command, kind: 'in', startTime: this.relativeTime() };
    this.terminalLines.push(line);
    this.terminalOut.textContent += '$ ' + command + '\n';
    this.captureTerminal();
    const kernel = this.panel.sessionContext.session?.kernel;
    if (kernel) {
      const future = kernel.requestExecute({ code: '!' + command, silent: true });
      future.onIOPub = msg => {
        if (this.clock) {
          return;
        }
        const content = msg.content as { text?: string };
        if (content.text) {
          this.terminalLines.push({
            text: content.text,
            kind: 'out',
            startTime: this.relativeTime()
          });
          this.terminalOut.textContent += content.text;
          this.captureTerminal();
        }
      };
      await future.done;
    }
    this.captureTerminal();
  }

  private captureTerminal(): void {
    if (!this.history) {
      return;
    }
    appendRecord(this.history, 'terminals', {
      startTime: nowMs(),
      terminals: [{ id: 'graffiti-term', lines: this.terminalLines.slice() }]
    });
  }

  private renderTerminal(record: TimedRecord | undefined): void {
    if (!record) {
      return;
    }
    const terminals = record.terminals as Array<{ lines?: TerminalLine[] }> | undefined;
    const lines = terminals && terminals[0] && terminals[0].lines;
    if (!lines) {
      return;
    }
    this.terminalOut.textContent = lines
      .map(line => (line.kind === 'in' ? '$ ' + line.text : line.text))
      .join('\n');
  }

  private penDown(event: PointerEvent): void {
    if (!this.drawing) {
      return;
    }
    const point = this.localPoint(event);
    this.stroke = [point];
  }

  private penMove(event: PointerEvent): void {
    if (!this.drawing || this.stroke.length === 0) {
      return;
    }
    this.stroke.push(this.localPoint(event));
    this.paint(this.stroke);
  }

  private penUp(): void {
    if (!this.drawing || this.stroke.length === 0) {
      return;
    }
    if (this.history) {
      const cell = this.panel.content.activeCell;
      appendRecord(this.history, 'drawings', {
        startTime: nowMs(),
        drawingActivity: 'draw',
        cellId: cell ? this.cellId(cell) : '',
        positions: this.stroke.slice(),
        pen: { color: this.penColor, temporary: this.temporaryInk, mode: this.penMode }
      });
    }
    this.stroke = [];
  }

  private drawFrame(record: TimedRecord | undefined): void {
    const positions = record && (record.positions as Array<{ x: number; y: number }>);
    const pen = record && (record.pen as { color?: string; temporary?: boolean; mode?: string } | undefined);
    const expired = Boolean(
      pen &&
        pen.temporary &&
        record &&
        this.clock &&
        this.clock.time > (record.startTime || 0) + 1500
    );
    if (expired || !positions || positions.length === 0) {
      if (!this.drawing) {
        this.hideStroke();
      }
      return;
    }
    this.canvas.classList.add('jp-graffiti-visible');
    this.placeCanvas();
    this.paint(positions, pen && pen.color, pen && pen.mode);
  }

  private placeCanvas(): void {
    const notebook = this.panel.content.node.getBoundingClientRect();
    const host = this.panel.node.getBoundingClientRect();
    this.canvas.style.left = notebook.left - host.left + 'px';
    this.canvas.style.top = notebook.top - host.top + 'px';
    this.canvas.style.width = notebook.width + 'px';
    this.canvas.style.height = notebook.height + 'px';
  }

  private paint(points: Array<{ x: number; y: number }>, color?: string, mode?: string): void {
    const notebook = this.panel.content.node;
    this.canvas.width = notebook.clientWidth;
    this.canvas.height = notebook.clientHeight;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (points.length === 0) {
      return;
    }
    const tool = mode || this.penMode;
    ctx.strokeStyle = color || this.penColor;
    ctx.lineWidth = tool === 'highlight' ? 10 : tool === 'eraser' ? 16 : 2;
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.globalAlpha = tool === 'highlight' ? 0.45 : 1;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();
  }

  private localPoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private showNotes(cell: Cell, phrases: string[]): void {
    cell.node.querySelectorAll('.jp-graffiti-note').forEach(node => node.remove());
    if (!this.clock || phrases.length === 0) {
      return;
    }
    const note = document.createElement('div');
    note.className = 'jp-graffiti-note';
    note.textContent = phrases.join(' · ');
    cell.node.appendChild(note);
  }

  private clearNotes(): void {
    this.panel.content.node.querySelectorAll('.jp-graffiti-note').forEach(node => node.remove());
  }

  private refreshMarkers(): void {
    this.panel.content.node.querySelectorAll('.jp-graffiti-marker').forEach(node => node.remove());
    this.panel.content.widgets.forEach(cell => {
      cell.node.classList.remove('jp-graffiti-has', 'jp-graffiti-hot');
      const id = cell.model.metadata.get('graffitiCellId') as string | undefined;
      if (!id || !this.manifest[id]) {
        return;
      }
      const movies = Object.keys(this.manifest[id]).filter(key => this.manifest[id][key].hasMovie);
      if (movies.length === 0) {
        return;
      }
      cell.node.classList.add('jp-graffiti-has');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jp-graffiti-marker';
      button.title = 'Graffiti is present on this line to the left.';
      button.innerHTML =
        '<svg viewBox="0 0 18 12" width="18" height="12" aria-hidden="true">' +
        '<path d="M1 1h16v7L9 11 1 8z" fill="rgb(47,147,107)"></path></svg>';
      button.addEventListener('pointerdown', event => {
        event.stopPropagation();
        event.preventDefault();
      });
      button.addEventListener('click', event => {
        event.stopPropagation();
        event.preventDefault();
        const found = latestRecording(this.manifest, id);
        if (found && found.recording.activeTakeId) {
          void this.playTake(found.cellId, found.recordingKey, found.recording.activeTakeId);
        }
      });
      button.addEventListener('pointerenter', () => cell.node.classList.add('jp-graffiti-hot'));
      button.addEventListener('pointerleave', () => cell.node.classList.remove('jp-graffiti-hot'));
      cell.node.appendChild(button);
    });
  }

  private readMeta(): NotebookMeta | undefined {
    const model = this.panel.content.model;
    if (!model) {
      return undefined;
    }
    const graffiti = model.metadata.get('graffiti') as unknown as NotebookMeta | undefined;
    if (!graffiti || !graffiti.id) {
      return undefined;
    }
    return graffiti;
  }

  private meta(): NotebookMeta {
    const model = this.panel.content.model;
    if (!model) {
      return { id: 'id_pending', language: 'EN', firstAuthorId: 'id_pending' };
    }
    const metadata = model.metadata;
    let graffiti = metadata.get('graffiti') as unknown as NotebookMeta | undefined;
    if (!graffiti || !graffiti.id) {
      graffiti = {
        id: generateUniqueId(),
        language: 'EN',
        firstAuthorId: generateUniqueId()
      };
      this.writeMeta(graffiti);
    }
    if (!graffiti.firstAuthorId) {
      graffiti.firstAuthorId = generateUniqueId();
      this.writeMeta(graffiti);
    }
    return graffiti;
  }

  private writeMeta(meta: NotebookMeta): void {
    const model = this.panel.content.model;
    if (!model) {
      return;
    }
    model.metadata.set(
      'graffiti',
      meta as unknown as import('@lumino/coreutils').ReadonlyPartialJSONValue
    );
  }

  private parts(meta: NotebookMeta, cellId: string, recordingKey: string): TakePathParts {
    return {
      notebookDirectory: notebookDirectory(this.panel.context.path),
      notebookId: meta.id,
      authorId: meta.firstAuthorId,
      recordingCellId: cellId,
      recordingKey,
      takeId: this.takeId
    };
  }

  private ensureCellIds(): void {
    this.panel.content.widgets.forEach(cell => this.cellId(cell));
  }

  private cellId(cell: Cell): string {
    const existing = cell.model.metadata.get('graffitiCellId') as string | undefined;
    if (existing) {
      return existing;
    }
    const id = generateUniqueId();
    cell.model.metadata.set('graffitiCellId', id);
    return id;
  }

  private findCell(cellId: string): Cell | undefined {
    return this.panel.content.widgets.find(
      cell => cell.model.metadata.get('graffitiCellId') === cellId
    );
  }

  private relativeTime(): number {
    if (!this.history) {
      return 0;
    }
    return nowMs() - this.history.recordingStartTime;
  }

  private async copyTree(from: string, to: string): Promise<void> {
    const contents = this.store.manager;
    let model;
    try {
      model = await contents.get(from);
    } catch {
      return;
    }
    if (model.type === 'directory') {
      await contents.save(to, { type: 'directory' });
      for (const child of model.content as Array<{ name: string; type: string }>) {
        await this.copyTree(from + '/' + child.name, to + '/' + child.name);
      }
      return;
    }
    const file = await contents.get(from, { content: true });
    await contents.save(to, {
      type: 'file',
      format: file.format,
      content: file.content
    });
  }

  private on(root: HTMLElement, selector: string, handler: () => void): void {
    const node = root.querySelector(selector);
    if (node) {
      node.addEventListener('click', handler);
    }
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private setMessage(text: string): void {
    const node = this.bar.querySelector('.jp-graffiti-message');
    if (node) {
      node.textContent = text;
    }
  }

  private async confirmActivate(): Promise<void> {
    const result = await showDialog({
      title: 'Activate Graffiti On This Notebook?',
      body:
        'Enable Graffiti on this Notebook, so you can begin using Graffiti for the first time? ' +
        'If you click Cancel, we will not change the notebook in any way. ' +
        "This process merely adds some metadata to the cells, but does not otherwise change the Notebook's contents.",
      buttons: [Dialog.cancelButton(), Dialog.okButton()]
    });
    if (!result.button.accept) {
      return;
    }
    this.meta();
    this.ensureCellIds();
    this.activated = true;
    this.editorShown = true;
    this.showActivity('idle');
    this.refreshIdle();
    this.setStatus('ready');
    this.notifyToolbar();
    await this.panel.context.save();
  }

  private beginPending(): void {
    if (!this.activated || this.access === 'view' || this.activity === 'recording') {
      return;
    }
    this.showActivity('recordingPending');
    this.setStatus('ready');
  }

  private cancelRecording(): void {
    if (this.activity === 'recordingPending') {
      this.showActivity('idle');
      this.refreshIdle();
      return;
    }
    if (!this.history) {
      this.showActivity('idle');
      return;
    }
    this.recordingCleanups.splice(0).forEach(cleanup => cleanup());
    this.panel.node.removeEventListener('scroll', this.onScroll, true);
    this.clearOverlay();
    this.recording = false;
    void this.audioCapture.stop();
    this.skipping = false;
    this.bar.classList.remove('is-skipping');
    const cellRecordings = this.manifest[this.recordingCellId];
    if (cellRecordings) {
      delete cellRecordings[this.recordingKey];
      if (Object.keys(cellRecordings).length === 0) {
        delete this.manifest[this.recordingCellId];
      }
    }
    this.history = undefined;
    this.showActivity('idle');
    this.refreshIdle();
    this.setStatus('ready');
  }

  private resumeOrPlay(): void {
    if (this.clock && (this.activity === 'playing' || this.activity === 'playbackPaused')) {
      if (this.clock.time >= this.clock.duration) {
        this.clock.seek(0);
      }
      this.clock.play();
      this.audioPlay.play(this.clock.time, this.clock.speed, this.muted);
      this.armTimer();
      this.showActivity('playing');
      this.setStatus('playing');
      return;
    }
    void this.playActive();
  }

  private skip(delta: number): void {
    if (!this.clock) {
      return;
    }
    this.clock.seek(Math.max(0, this.clock.time + delta));
    this.audioPlay.seek(this.clock.time);
    this.renderFrame();
  }

  private async cleanupTakes(): Promise<void> {
    const cell = this.panel.content.activeCell;
    const id = cell && (cell.model.metadata.get('graffitiCellId') as string | undefined);
    const found = id ? latestRecording(this.manifest, id) : undefined;
    if (!found || !found.recording.activeTakeId || !found.recording.takes) {
      return;
    }
    const active = found.recording.activeTakeId;
    const kept = found.recording.takes[active];
    if (kept) {
      found.recording.takes = { [active]: kept };
    }
    await this.store.writeManifest(this.parts(this.meta(), found.cellId, found.recordingKey), this.manifest);
    this.refreshIdle();
  }

  private async removeActive(): Promise<void> {
    const cell = this.panel.content.activeCell;
    const id = cell && (cell.model.metadata.get('graffitiCellId') as string | undefined);
    const found = id ? latestRecording(this.manifest, id) : undefined;
    if (!found) {
      return;
    }
    const result = await showDialog({
      title: 'Remove Graffiti',
      body: 'Remove this Graffiti from the notebook?',
      buttons: [Dialog.cancelButton(), Dialog.okButton()]
    });
    if (!result.button.accept) {
      return;
    }
    delete this.manifest[found.cellId][found.recordingKey];
    if (Object.keys(this.manifest[found.cellId]).length === 0) {
      delete this.manifest[found.cellId];
    }
    await this.store.writeManifest(this.parts(this.meta(), found.cellId, found.recordingKey), this.manifest);
    this.refreshMarkers();
    this.refreshIdle();
    this.setStatus('ready');
  }

  private showActivity(activity: string): void {
    this.activity = activity;
    this.bar.dataset.activity = activity;
    if (activity === 'recordingPending') {
      this.setMessage('Click anywhere in the notebook to begin recording your movie.');
    } else if (activity === 'recording') {
      this.setMessage('Your activities are being recorded. Hold the option key down to end recording.');
    } else if (activity === 'playing' || activity === 'playbackPaused') {
      this.setMessage('Press ESC to end movie playback');
    }
    this.present();
  }

  private present(): void {
    const live =
      this.activity === 'playing' ||
      this.activity === 'playbackPaused' ||
      this.activity === 'recording' ||
      this.activity === 'recordingPending';
    this.bar.classList.toggle('jp-graffiti-hidden', !(this.editorShown || live));
  }

  private notifyToolbar(): void {
    if (!this.activated) {
      this.labelSetter('Activate Graffiti');
      return;
    }
    this.labelSetter(this.editorShown ? 'Hide Graffiti Editor' : 'Show Graffiti Editor');
  }

  private refreshIdle(): void {
    const cell = this.panel.content.activeCell;
    const id = cell && (cell.model.metadata.get('graffitiCellId') as string | undefined);
    const found = id ? latestRecording(this.manifest, id) : undefined;
    const hasMovie = Boolean(found && found.recording.hasMovie);
    this.bar.classList.toggle('has-movie', hasMovie);
    if (this.activity === 'idle') {
      this.setMessage(
        hasMovie
          ? 'You can play this movie any time via its tooltip.'
          : 'Select some text in a cell to create or modify Graffiti, click inside any existing Graffiti text to modify that Graffiti, or use Graffiti Extras (below)'
      );
    }
    this.renderTakes(found);
  }

  private renderTakes(
    found: { recording: ManifestRecording } | undefined
  ): void {
    const list = this.bar.querySelector('.jp-graffiti-takes-list');
    if (!list) {
      return;
    }
    list.textContent = '';
    if (!found || !found.recording.takes) {
      return;
    }
    const active = found.recording.activeTakeId;
    Object.keys(found.recording.takes).forEach((takeId, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jp-graffiti-take' + (takeId === active ? ' is-selected' : '');
      button.textContent = String(index + 1);
      button.title = 'Recorded';
      button.addEventListener('click', () => {
        found.recording.activeTakeId = takeId;
        this.renderTakes(found);
      });
      list.appendChild(button);
    });
  }

  private restoreSnapshot(): void {
    for (const item of this.snapshot) {
      const cell = this.findCell(item.id);
      if (cell && cell.model.value.text !== item.text) {
        cell.model.value.text = item.text;
      }
    }
  }

  private choosePen(mode: 'pen' | 'highlight' | 'eraser'): void {
    this.penMode = mode;
    this.drawing = true;
    this.canvas.classList.add('jp-graffiti-drawing');
    this.placeCanvas();
  }

  private markColor(): void {
    this.bar.querySelectorAll('.jp-graffiti-color').forEach(node => {
      const selected = '#' + (node as HTMLElement).dataset.color === this.penColor;
      node.classList.toggle('is-selected', selected);
    });
  }

  private dragFrom(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', event => {
      if ((event.target as HTMLElement).closest('button, input, a')) {
        return;
      }
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = this.bar.getBoundingClientRect();
      const host = this.panel.node.getBoundingClientRect();
      const originLeft = rect.left - host.left;
      const originTop = rect.top - host.top;
      const move = (ev: PointerEvent): void => {
        this.bar.style.left = originLeft + ev.clientX - startX + 'px';
        this.bar.style.top = originTop + ev.clientY - startY + 'px';
        this.bar.style.right = 'auto';
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
    });
  }

  private onNotebookPointer = (event: PointerEvent): void => {
    if (this.activity !== 'recordingPending' || this.recording) {
      return;
    }
    const target = event.target as Node | null;
    if (!target || this.bar.contains(target)) {
      return;
    }
    if (!this.panel.content.node.contains(target) && target !== this.canvas) {
      return;
    }
    void this.startRecording();
  };

  private hideStroke(): void {
    this.canvas.classList.remove('jp-graffiti-visible');
    this.wipeCanvas();
  }

  private clearOverlay(): void {
    this.drawing = false;
    this.stroke = [];
    this.appliedDrawing = undefined;
    this.canvas.classList.remove('jp-graffiti-visible', 'jp-graffiti-drawing');
    this.wipeCanvas();
  }

  private wipeCanvas(): void {
    const width = this.canvas.width;
    this.canvas.width = width;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const typing = Boolean(
      target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    );
    if (event.key === 'Alt' && this.activity === 'recording' && !event.repeat) {
      this.altDownAt = nowMs();
      this.skipping = true;
      this.bar.classList.add('is-skipping');
    }
    if (event.key === 'Escape') {
      if (this.activity === 'playing' || this.activity === 'playbackPaused') {
        this.stopPlayback(true);
      } else if (this.activity === 'recording' || this.activity === 'recordingPending') {
        this.cancelRecording();
      }
    }
    if (
      event.key === ' ' &&
      !typing &&
      (this.activity === 'playing' || this.activity === 'playbackPaused')
    ) {
      event.preventDefault();
      if (this.activity === 'playing') {
        this.pause();
      } else {
        this.resumeOrPlay();
      }
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt' || this.activity !== 'recording') {
      return;
    }
    const held = nowMs() - this.altDownAt;
    this.skipping = false;
    this.bar.classList.remove('is-skipping');
    if (held > 650) {
      void this.stopRecording();
    }
  };

  private stopTimer(): void {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = 0;
    }
  }
}

export function previewCell(history: History, time: number, cellId: string): string | undefined {
  return cellTextAt(history, time, cellId);
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
}

const COLORS = ['000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff9900', '8a2be2', '996600'];

const PANEL_HTML = [
  '<div class="jp-graffiti-panel-inner">',
  '<div class="jp-graffiti-drag" title="drag"></div>',
  '<div class="jp-graffiti-body">',
  '<div class="jp-graffiti-title"><span class="jp-graffiti-mark"></span><span class="jp-graffiti-logo">graffiti</span></div>',
  '<div class="jp-graffiti-section jp-graffiti-section-idle">',
  '<button type="button" class="jp-graffiti-record" title="Record movie">Record</button>',
  '<button type="button" class="jp-graffiti-rerecord" title="Rerecord movie">Rerecord</button>',
  '<button type="button" class="jp-graffiti-cleanup" title="Cleanup Takes">Cleanup Takes</button>',
  '<button type="button" class="jp-graffiti-remove" title="Remove Graffiti">Remove Graffiti</button>',
  '</div>',
  '<div class="jp-graffiti-section jp-graffiti-section-takes">',
  '<span class="jp-graffiti-takes-title">Takes</span><div class="jp-graffiti-takes-list"></div>',
  '</div>',
  '<div class="jp-graffiti-section jp-graffiti-section-recording">',
  '<div class="jp-graffiti-recording-help">',
  '<button type="button" class="jp-graffiti-stop" title="End Recording"><div>option/alt</div><div>key</div></button>',
  '<div class="jp-graffiti-hint"><div><span>Tap</span>: Pause Rec.</div><div><span>Hold</span>: End Rec.</div></div>',
  '</div>',
  '<div class="jp-graffiti-recording-status"><span class="jp-graffiti-flash"></span><span class="jp-graffiti-rec-time">00:00</span></div>',
  '<div class="jp-graffiti-pens">',
  '<button type="button" class="jp-graffiti-pen" title="Freeform pen tool">Pen</button>',
  '<button type="button" class="jp-graffiti-highlight" title="Highlighter tool">Mark</button>',
  '<button type="button" class="jp-graffiti-eraser" title="Eraser tool">Erase</button>',
  '<button type="button" class="jp-graffiti-draw" title="Draw">Draw</button>',
  '</div>',
  '<div class="jp-graffiti-colors">' +
    COLORS.map(color => '<button type="button" class="jp-graffiti-color" data-color="' + color + '" style="background:#' + color + '"></button>').join('') +
    '</div>',
  '<label class="jp-graffiti-ink"><input type="checkbox" checked />Temporary Ink</label>',
  '</div>',
  '<div class="jp-graffiti-section jp-graffiti-section-playback">',
  '<div class="jp-graffiti-playback-buttons">',
  '<button type="button" class="jp-graffiti-play" title="Start playback">Play</button>',
  '<button type="button" class="jp-graffiti-pause" title="Pause playback (spacebar)">Pause</button>',
  '<button type="button" class="jp-graffiti-skip-back" title="Skip back 5 second">-5s</button>',
  '<button type="button" class="jp-graffiti-skip-forward" title="Skip forward 5 second">+5s</button>',
  '<button type="button" class="jp-graffiti-mute" title="Mute audio">Mute</button>',
  '<button type="button" class="jp-graffiti-speed" title="Switch to high speed playback">1x</button>',
  '</div>',
  '<div class="jp-graffiti-scrub-row">',
  '<input class="jp-graffiti-scrub" type="range" min="0" max="0" value="0" title="scrub" />',
  '<span class="jp-graffiti-play-time">00:00</span>',
  '<button type="button" class="jp-graffiti-exit" title="Exit movie (restore notebook contents)">Exit</button>',
  '</div>',
  '</div>',
  '<div class="jp-graffiti-section jp-graffiti-section-notifier">',
  '<div class="jp-graffiti-notifier"><div class="jp-graffiti-message"></div>',
  '<span class="jp-graffiti-cancel">Cancel recording</span></div>',
  '</div>',
  '<div class="jp-graffiti-section jp-graffiti-section-terminal">',
  '<div class="jp-graffiti-terminal">',
  '<pre class="jp-graffiti-terminal-out"></pre>',
  '<input class="jp-graffiti-terminal-in" placeholder="terminal command" />',
  '</div></div>',
  '<span class="jp-graffiti-status"></span>',
  '</div></div>'
].join('');
