/**
 * Point @monaco-editor/react at the locally installed `monaco-editor` instead of
 * its default, which loads Monaco from cdn.jsdelivr.net at runtime. Bundling it
 * keeps the editor working offline and keeps remote code out of the renderer, so
 * the CSP does not have to allow a CDN for scripts, styles, fonts or workers.
 *
 * Workers are bundled by Vite (`?worker`) and served from 'self'.
 */
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker?worker'
import CssWorker from 'monaco-editor/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker'

/** The worker Monaco asks for by label; anything without a language service gets the base editor worker. */
export function workerForLabel(label: string): Worker {
  switch (label) {
    case 'json':
      return new JsonWorker()
    case 'css':
    case 'scss':
    case 'less':
      return new CssWorker()
    case 'html':
    case 'handlebars':
    case 'razor':
      return new HtmlWorker()
    case 'typescript':
    case 'javascript':
      return new TsWorker()
    default:
      return new EditorWorker()
  }
}

self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => workerForLabel(label)
}

loader.config({ monaco })
