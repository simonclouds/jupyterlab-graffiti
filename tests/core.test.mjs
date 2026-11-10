import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { decompressJson } from '../lib/core/codec.js';
import { PlaybackClock } from '../lib/core/clock.js';
import {
  cellTextAt,
  emptyHistory,
  framesAt,
  highlightPhrases,
  latestRecording,
  normalizeTimeline,
  plainSource,
  selectionRange
} from '../lib/core/history.js';
import { historyPath, manifestPath, parentDirectories } from '../lib/core/paths.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('paths match the classic jupytergraffiti_data layout', () => {
  const parts = {
    notebookDirectory: 'work',
    notebookId: 'id_5ukx313',
    authorId: 'id_c62g2wz',
    recordingCellId: 'id_oqvp5lq',
    recordingKey: 'id_s5usd81',
    takeId: 'id_037wfd8'
  };
  assert.equal(
    manifestPath(parts),
    'work/jupytergraffiti_data/notebooks/id_5ukx313/authors/id_c62g2wz/manifest.json'
  );
  assert.equal(
    historyPath(parts),
    'work/jupytergraffiti_data/notebooks/id_5ukx313/authors/id_c62g2wz/cells/id_oqvp5lq/graffitis/id_s5usd81/takes/id_037wfd8/history.txt'
  );
  assert.deepEqual(parentDirectories('a/b/c.txt'), ['a', 'a/b']);
});

test('real history fixture keeps event tracks and cell text', () => {
  const payload = fs.readFileSync(path.join(root, 'fixtures/history.txt'), 'utf8');
  const history = decompressJson(payload);
  assert.equal(history.duration, 4371);
  assert.equal(history.storageCellId, 'id_oqvp5lq');
  assert.equal(history.view.length, 3);
  assert.equal(history.selections.length, 1);
  assert.equal(history.contents.length, 1);
  assert.equal(history.drawings.length, 0);
  assert.equal(history.terminals.length, 1);
  assert.equal(history.speaking.length, 3);
  assert.equal(history.skip.length, 1);
  assert.equal(cellTextAt(history, 100, 'id_cqow57u'), "print('hi')");
  const frames = framesAt(history, 100);
  assert.ok(frames.contents);
  assert.ok(frames.view);
});

test('classic highlight markup becomes source plus annotation phrases', () => {
  const html =
    '<span class="graffiti-highlight graffiti-id_oqvp5lq-id_s5usd81"><i></i>markdown</span> me';
  assert.equal(plainSource(html), 'markdown me');
  assert.deepEqual(highlightPhrases(html), ['markdown']);
  assert.deepEqual(
    selectionRange({ anchor: { line: 3, ch: 10 }, head: { line: 3, ch: 10 } }),
    { start: { line: 3, column: 10 }, end: { line: 3, column: 10 } }
  );
});

test('a one millisecond terminal frame is still visible after the clock jumps past it', () => {
  const history = emptyHistory(0);
  history.terminals.push({
    startTime: 100,
    endTime: 101,
    terminals: [{ lines: [{ text: 'echo graffiti-ok', kind: 'in', startTime: 100 }] }]
  });
  const frame = framesAt(history, 150);
  assert.equal(frame.terminals.terminals[0].lines[0].text, 'echo graffiti-ok');
});

test('playback clock pauses, seeks, and doubles time', () => {
  const clock = new PlaybackClock(1000);
  clock.tick(100);
  assert.equal(clock.time, 0);
  clock.play();
  clock.tick(100);
  assert.equal(clock.time, 100);
  clock.setSpeed(2);
  clock.tick(100);
  assert.equal(clock.time, 300);
  clock.seek(1000);
  assert.equal(clock.playing, false);
});

test('play chooses the newest movie, and a negative timeline starts at zero', () => {
  const manifest = {
    id_old_cell: {
      id_first: { createDate: 10, hasMovie: true, activeTakeId: 'id_take_a' },
      id_second: { createDate: 30, hasMovie: true, activeTakeId: 'id_take_b' }
    },
    id_new_cell: {
      id_third: { createDate: 20, hasMovie: true, activeTakeId: 'id_take_c' }
    }
  };
  assert.equal(latestRecording(manifest).recordingKey, 'id_second');
  assert.equal(latestRecording(manifest, 'id_new_cell').recordingKey, 'id_third');

  const history = emptyHistory(5000, 'id_cell');
  history.contents.push({
    startTime: -5000,
    endTime: -4000,
    cellsContent: {},
    cellsPresentThisFrame: {}
  });
  history.contents.push({
    startTime: -1000,
    endTime: 0,
    cellsContent: {},
    cellsPresentThisFrame: {}
  });
  history.duration = 1000;
  normalizeTimeline(history);
  assert.equal(history.contents[0].startTime, 0);
  assert.equal(history.contents[1].startTime, 4000);
  assert.equal(cellTextAt(history, 0, 'missing'), undefined);
});
