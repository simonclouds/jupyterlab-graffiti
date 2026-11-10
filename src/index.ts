import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';

import { GraffitiSession } from './session';
import { GraffitiStore } from './storage';

import '../style/index.css';

const sessions = new Map<string, GraffitiSession>();

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'jupyterlab-graffiti:plugin',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    const store = new GraffitiStore(app.serviceManager.contents);
    const attach = (panel: import('@jupyterlab/notebook').NotebookPanel): void => {
      if (sessions.has(panel.id)) {
        return;
      }
      const host = new Widget();
      host.addClass('jp-Toolbar-item');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jp-graffiti-activate';
      button.title = 'Jupyter Graffiti';
      button.textContent = 'Activate Graffiti';
      host.node.appendChild(button);
      const session = new GraffitiSession(panel, store);
      session.setToolbar((text: string) => {
        button.textContent = text;
      });
      button.addEventListener('click', () => session.toggleFromToolbar());
      panel.toolbar.insertItem(0, 'graffiti', host);
      sessions.set(panel.id, session);
      panel.disposed.connect(() => {
        session.dispose();
        sessions.delete(panel.id);
      });
    };
    tracker.widgetAdded.connect((_, panel) => attach(panel));
    tracker.forEach(panel => attach(panel));
  }
};

export default plugin;
