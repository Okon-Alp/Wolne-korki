// Tablica lekcji oparta na Excalidraw (MIT). Budowana do public/board/ poleceniem `npm run build`.
// Synchronizacja: wysyłamy tylko elementy, które zmieniły wersję; scalanie przez reconcileElements.
import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw, MainMenu, WelcomeScreen, reconcileElements, restoreElements, exportToBlob, CaptureUpdateAction,
} from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const SEND_EVERY_MS = 50;
const COLORS = [
  { background: '#ffd8a8', stroke: '#e8590c' },
  { background: '#a5d8ff', stroke: '#1971c2' },
  { background: '#b2f2bb', stroke: '#2f9e44' },
  { background: '#eebefa', stroke: '#9c36b5' },
];

/**
 * Montuje tablicę w elemencie `host`.
 * opts.send(msg)         wysyła operację do pokoju ({ op: 'elements' | 'files' | 'pointer', ... })
 * opts.theme             'light' | 'dark'
 * opts.onSaveToMaterials wywoływane z menu tablicy
 * Zwraca Promise z kontrolerem: init(), remote(), peerLeft(), exportPng(), fit(), destroy().
 */
export function mountBoard(host, { send, theme = 'light', onSaveToMaterials }) {
  return new Promise((resolve) => {
    let api = null;
    let ready = false;
    let latest = null;
    let timer = null;
    let lastPointer = 0;
    const knownVersions = new Map(); // id -> wersja, którą zna już druga strona
    const knownFiles = new Set();
    const collaborators = new Map();

    function flush() {
      timer = null;
      if (!latest) return;
      const changed = [];
      for (const el of latest) {
        if (knownVersions.get(el.id) !== el.version) {
          changed.push(el);
          knownVersions.set(el.id, el.version);
        }
      }
      latest = null;
      if (changed.length) send({ op: 'elements', elements: changed });
    }

    function onChange(elements, _appState, files) {
      if (!ready) return;
      latest = elements;
      if (!timer) timer = setTimeout(flush, SEND_EVERY_MS);
      const fresh = [];
      for (const [id, f] of Object.entries(files || {})) {
        if (!knownFiles.has(id) && f?.dataURL) { knownFiles.add(id); fresh.push(f); }
      }
      if (fresh.length) send({ op: 'files', files: fresh });
    }

    function onPointerUpdate({ pointer, button }) {
      const now = performance.now();
      if (now - lastPointer < SEND_EVERY_MS && button !== 'down') return;
      lastPointer = now;
      send({ op: 'pointer', x: Math.round(pointer.x), y: Math.round(pointer.y), tool: pointer.tool, button });
    }

    function applyElements(remote) {
      if (!api || !Array.isArray(remote) || !remote.length) return;
      const restored = restoreElements(remote, null);
      for (const el of restored) knownVersions.set(el.id, el.version);
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), restored, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    }

    function applyFiles(files) {
      if (!api || !files?.length) return;
      for (const f of files) knownFiles.add(f.id);
      api.addFiles(files);
    }

    let initialized = false;
    const controller = {
      /** Stan z serwera: przy pierwszym wejściu zastępuje tablicę, po zerwaniu połączenia scala ją z lokalnymi zmianami. */
      init({ elements = [], files = {} } = {}) {
        if (initialized) {
          knownVersions.clear();
          knownFiles.clear();
          for (const id of Object.keys(files)) knownFiles.add(id);
          applyFiles(Object.values(files));
          applyElements(elements);
          // Wyślij to, co narysowaliśmy offline (elementy z inną wersją niż na serwerze) i brakujące obrazki.
          latest = api.getSceneElementsIncludingDeleted();
          flush();
          const missing = Object.values(api.getFiles()).filter((f) => !knownFiles.has(f.id) && f.dataURL);
          missing.forEach((f) => knownFiles.add(f.id));
          if (missing.length) send({ op: 'files', files: missing });
          return;
        }
        initialized = true;
        ready = false;
        knownVersions.clear();
        applyFiles(Object.values(files));
        const restored = restoreElements(elements, null);
        for (const el of restored) knownVersions.set(el.id, el.version);
        api.updateScene({ elements: restored, captureUpdate: CaptureUpdateAction.NEVER });
        api.history?.clear?.();
        if (restored.some((e) => !e.isDeleted)) {
          setTimeout(() => api.scrollToContent(undefined, { fitToContent: true, animate: false }), 50);
        }
        ready = true;
      },
      /** Operacja od drugiej osoby. */
      remote(m) {
        if (m.op === 'elements') applyElements(m.elements);
        else if (m.op === 'files') applyFiles(m.files);
        else if (m.op === 'pointer') {
          const key = String(m.uid);
          collaborators.set(key, {
            id: key, socketId: key, username: m.name,
            pointer: { x: m.x, y: m.y, tool: m.tool === 'laser' ? 'laser' : 'pointer' },
            button: m.button === 'down' ? 'down' : 'up',
            color: COLORS[Number(m.uid) % COLORS.length],
          });
          api.updateScene({ collaborators: new Map(collaborators) });
        }
      },
      peerLeft(uid) {
        collaborators.delete(String(uid));
        api?.updateScene({ collaborators: new Map(collaborators) });
      },
      async exportPng() {
        return exportToBlob({
          elements: api.getSceneElements(),
          appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
          files: api.getFiles(),
          mimeType: 'image/png',
          exportPadding: 24,
        });
      },
      fit() { api?.scrollToContent(undefined, { fitToContent: true, animate: true }); },
      isEmpty() { return !api?.getSceneElements().length; },
      destroy() { clearTimeout(timer); root.unmount(); },
    };

    function Board() {
      return (
        <Excalidraw
          langCode="pl-PL"
          theme={theme}
          isCollaborating
          excalidrawAPI={(a) => {
            if (api) return;
            api = a;
            resolve(controller);
          }}
          onChange={onChange}
          onPointerUpdate={onPointerUpdate}
          initialData={{
            appState: {
              viewBackgroundColor: '#ffffff',
              gridModeEnabled: true,
              currentItemRoughness: 0,
              currentItemFontFamily: 5,
            },
          }}
          UIOptions={{
            canvasActions: {
              loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false,
              saveAsImage: true, clearCanvas: true, changeViewBackgroundColor: true,
            },
          }}
        >
          <MainMenu>
            {onSaveToMaterials && <MainMenu.Item onSelect={onSaveToMaterials}>Zapisz w materiałach lekcji</MainMenu.Item>}
            <MainMenu.Item onSelect={() => controller.fit()}>Pokaż całą tablicę</MainMenu.Item>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.Separator />
            <MainMenu.DefaultItems.Help />
            <MainMenu.DefaultItems.ClearCanvas />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Hints.ToolbarHint />
            <WelcomeScreen.Hints.MenuHint />
            <WelcomeScreen.Hints.HelpHint />
            <WelcomeScreen.Center>
              <WelcomeScreen.Center.Heading>Wspólna tablica: rysujecie oboje naraz.</WelcomeScreen.Center.Heading>
            </WelcomeScreen.Center>
          </WelcomeScreen>
        </Excalidraw>
      );
    }

    const root = createRoot(host);
    root.render(<Board />);
  });
}
