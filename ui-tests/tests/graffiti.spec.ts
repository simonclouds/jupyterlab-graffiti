import { expect, test } from '@jupyterlab/galata';
import * as LZString from 'lz-string';
import * as path from 'path';

const notebooks = path.resolve(__dirname, '../notebooks');

async function stubMicrophone(page: any): Promise<void> {
  await page.evaluate(() => {
    const nav = navigator as any;
    nav.mediaDevices = nav.mediaDevices || {};
    nav.mediaDevices.getUserMedia = async () => ({
      getTracks: () => [{ stop() {} }]
    });
    (window as any).MediaRecorder = class {
      state = 'inactive';
      onstop: (() => void) | null = null;
      ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
      start(): void {
        this.state = 'recording';
      }
      stop(): void {
        this.state = 'inactive';
        if (this.ondataavailable) {
          this.ondataavailable({ data: { size: 0 } });
        }
        if (this.onstop) {
          this.onstop();
        }
      }
    };
  });
}

async function cellTexts(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const panel = (window as any).jupyterapp.shell.currentWidget;
    return panel.content.widgets.map((cell: any) => cell.model.value.text);
  });
}

async function clickBar(page: any, selector: string): Promise<void> {
  await page.locator(selector).click({ force: true });
}

async function openEditor(page: any): Promise<void> {
  const panel = page.locator('.jp-graffiti-panel');
  if (await panel.isVisible()) {
    return;
  }
  await page.locator('.jp-graffiti-activate').click();
  const accept = page.locator('.jp-Dialog .jp-mod-accept');
  if (await accept.isVisible()) {
    await accept.click();
  }
  await expect(panel).toBeVisible();
  await expect(page.locator('.jp-graffiti-activate')).toHaveText('Hide Graffiti Editor');
}

async function clickMarker(page: any): Promise<void> {
  await page.evaluate(() => {
    const marker = document.querySelector(
      '.jp-NotebookPanel:not(.lm-mod-hidden) .jp-graffiti-marker'
    ) as HTMLElement | null;
    if (!marker) {
      throw new Error('graffiti marker is missing');
    }
    marker.click();
  });
}

async function beginRecording(page: any): Promise<void> {
  await stubMicrophone(page);
  await openEditor(page);
  await clickBar(page, '.jp-graffiti-record');
  await expect(page.locator('.jp-graffiti-message')).toContainText(
    'Click anywhere in the notebook to begin recording your movie.'
  );
  await page.locator('.jp-Notebook .jp-Cell').first().click({ force: true, position: { x: 24, y: 24 } });
  await expect(page.locator('.jp-graffiti-status')).toHaveText('recording');
}

async function waitReady(page: any): Promise<void> {
  await page.waitForFunction(() => Boolean((window as any).GraffitiLab));
  await expect(page.locator('.jp-graffiti-status')).toHaveText('ready');
}

test('plays a classic recording, then pause scrub speed and mute', async ({
  page,
  tmpPath
}) => {
  await page.contents.uploadDirectory(notebooks, tmpPath);
  await page.notebook.openByPath(`${tmpPath}/classic.ipynb`);
  await waitReady(page);

  await expect(page.locator('.jp-graffiti-note')).toHaveCount(0);
  await page.evaluate(() => (window as any).GraffitiLab.playRecordingById('id_s5usd81'));
  await expect.poll(async () => (await cellTexts(page))[2]).toBe("print('hi')");
  await expect.poll(async () => (await cellTexts(page))[0]).toBe('markdown me');
  await expect(page.locator('.jp-graffiti-note').first()).toContainText('markdown');

  await page.locator('.jp-graffiti-scrub').fill('1000');
  await clickBar(page, '.jp-graffiti-speed');
  await expect(page.locator('.jp-graffiti-speed')).toHaveText('2x');
  await clickBar(page, '.jp-graffiti-mute');
  await expect(page.locator('.jp-graffiti-mute')).toHaveText('Muted');
  await clickBar(page, '.jp-graffiti-pause');
  await expect(page.locator('.jp-graffiti-status')).toHaveText('paused');
  await expect(page.locator('.jp-graffiti-note').first()).toBeVisible();

  await page.evaluate(() => (window as any).GraffitiLab.stopPlayback());
  await expect(page.locator('.jp-graffiti-note')).toHaveCount(0);
  await expect(page.locator('.jp-graffiti-status')).toHaveText('stopped');
});

test('records edits, execution, scroll and a drawing into jupytergraffiti_data', async ({
  page,
  tmpPath
}) => {
  await page.notebook.createNew('record.ipynb');
  await waitReady(page);
  await beginRecording(page);

  await page.notebook.setCell(0, 'code', 'print(1 + 1)');
  await page.evaluate(() => {
    const notebook = document.querySelector('.jp-Notebook') as HTMLElement;
    notebook.scrollTop = 30;
    notebook.dispatchEvent(new Event('scroll'));
  });
  await page.notebook.runCell(0);
  await clickBar(page, '.jp-graffiti-draw');
  const canvas = page.locator('.jp-graffiti-overlay');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('drawing canvas has no box');
  }
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 80, box.y + 50);
  await page.mouse.up();
  await clickBar(page, '.jp-graffiti-stop');
  await expect(page.locator('.jp-graffiti-status')).toContainText('saved');
  await expect(page.locator('.jp-graffiti-marker')).toHaveCount(1);
  await expect(page.locator('.jp-graffiti-marker')).toHaveAttribute(
    'title',
    'Graffiti is present on this line to the left.'
  );

  const saved = await page.evaluate(async () => {
    const panel = (window as any).jupyterapp.shell.currentWidget;
    const meta = panel.content.model.metadata.get('graffiti');
    const directory = panel.context.path.replace(/[^/]+$/, '');
    const manifestPath =
      directory +
      'jupytergraffiti_data/notebooks/' +
      meta.id +
      '/authors/' +
      meta.firstAuthorId +
      '/manifest.json';
    const response = await fetch('/api/contents/' + manifestPath + '?content=1');
    const model = await response.json();
    return { manifest: model.content as string, path: manifestPath };
  });
  const manifest = JSON.parse(LZString.decompressFromBase64(saved.manifest) || '{}');
  const cellId = Object.keys(manifest)[0];
  const recordingKey = Object.keys(manifest[cellId])[0];
  const recording = manifest[cellId][recordingKey];
  expect(recording.hasMovie).toBe(true);
  const historyPath = saved.path.replace(
    'manifest.json',
    'cells/' +
      cellId +
      '/graffitis/' +
      recordingKey +
      '/takes/' +
      recording.activeTakeId +
      '/history.txt'
  );
  const historyModel = await page.evaluate(async historyPath => {
    const response = await fetch('/api/contents/' + historyPath + '?content=1');
    return (await response.json()).content as string;
  }, historyPath);
  const history = JSON.parse(LZString.decompressFromBase64(historyModel) || '{}');
  expect(history.contents.length).toBeGreaterThan(0);
  expect(history.view.some((frame: any) => frame.subType === 'scroll')).toBe(true);
  expect(history.drawings.length).toBeGreaterThan(0);
  const texts = JSON.stringify(history.contents);
  expect(texts).toContain('print(1 + 1)');

  await page.notebook.setCell(0, 'code', 'CHANGED');
  await clickMarker(page);
  await expect.poll(async () => (await cellTexts(page))[0]).toBe('print(1 + 1)');
  expect(await page.contents.directoryExists(`${tmpPath}/jupytergraffiti_data`)).toBe(true);
});

test('replays edits in order without pinning notebook scroll', async ({ page }) => {
  await page.notebook.createNew('replay.ipynb');
  await waitReady(page);
  await page.evaluate(() => {
    const panel = (window as any).jupyterapp.shell.currentWidget;
    const model = panel.content.model.sharedModel;
    for (let i = 0; i < 24; i += 1) {
      model.insertCell(model.cells.length, { cell_type: 'code', source: 'pad ' + i });
    }
  });
  await beginRecording(page);
  const setSource = async (text: string): Promise<void> => {
    await page.evaluate(value => {
      const panel = (window as any).jupyterapp.shell.currentWidget;
      panel.content.widgets[0].model.value.text = value;
    }, text);
  };
  await setSource('alpha');
  await page.waitForTimeout(800);
  await setSource('alpha beta');
  await clickBar(page, '.jp-graffiti-stop');
  await expect(page.locator('.jp-graffiti-status')).toContainText('saved');
  await page.notebook.setCell(0, 'code', 'CHANGED');
  await clickMarker(page);
  await expect.poll(async () => (await cellTexts(page))[0]).toBe('alpha');
  await expect.poll(async () => (await cellTexts(page))[0]).toBe('alpha beta');
  const scrolled = await page.evaluate(async () => {
    const notebook = document.querySelector('.jp-Notebook') as HTMLElement;
    const max = notebook.scrollHeight - notebook.clientHeight;
    const target = Math.min(140, max);
    notebook.scrollTop = target;
    await new Promise(resolve => setTimeout(resolve, 350));
    return { max, target, now: notebook.scrollTop };
  });
  expect(scrolled.max).toBeGreaterThan(80);
  expect(Math.abs(scrolled.now - scrolled.target)).toBeLessThan(20);
});

test('python comm API starts and stops playback', async ({ page, tmpPath }) => {
  await page.contents.uploadDirectory(notebooks, tmpPath);
  await page.notebook.openByPath(`${tmpPath}/classic.ipynb`);
  await waitReady(page);
  await page.notebook.addCell(
    'code',
    "from jupyterlab_graffiti import play_recording\nplay_recording('id_s5usd81')\n"
  );
  await page.notebook.selectCells(6);
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await cellTexts(page))[2], { timeout: 30000 }).toBe("print('hi')");
  await page.evaluate(async () => {
    const panel = (window as any).jupyterapp.shell.currentWidget;
    const kernel = panel.sessionContext.session.kernel;
    await kernel.requestExecute({
      code: 'from jupyterlab_graffiti import stop_playback\nstop_playback()\n'
    }).done;
  });
  await expect(page.locator('.jp-graffiti-status')).toHaveText('stopped', { timeout: 30000 });
});

test('replays an inline terminal command without running it again', async ({ page }) => {
  await page.notebook.createNew('terminal.ipynb');
  await waitReady(page);
  await beginRecording(page);
  await page.locator('.jp-graffiti-terminal-in').fill('echo graffiti-ok');
  await page.locator('.jp-graffiti-terminal-in').press('Enter');
  await expect(page.locator('.jp-graffiti-terminal-out')).toContainText('echo graffiti-ok');
  await clickBar(page, '.jp-graffiti-stop');
  await expect(page.locator('.jp-graffiti-status')).toContainText('saved');
  await page.evaluate(() => {
    const out = document.querySelector('.jp-graffiti-terminal-out');
    if (out) {
      out.textContent = '';
    }
  });
  await clickMarker(page);
  await expect(page.locator('.jp-graffiti-terminal-out')).toContainText('$ echo graffiti-ok');
});
