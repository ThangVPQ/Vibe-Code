import { monaco, languageFor } from './monaco'
import { fileUri, useStore } from './store'
import { registerFileModels } from './fileModelsLite'

/** alternativeVersionId of each model at its last load/save — anything else means "dirty". */
const saved = new Map<string, number>()

export function getModel(path: string): monaco.editor.ITextModel | null {
  return monaco.editor.getModel(monaco.Uri.parse(fileUri(path)))
}

export async function ensureModel(path: string): Promise<{ model: monaco.editor.ITextModel | null; error?: string }> {
  const existing = getModel(path)
  if (existing) return { model: existing }
  const r = await window.api.fs.readFile(path).catch((e: Error) => ({ error: e.message }) as const)
  if ('error' in r) return { model: null, error: r.error }
  if (r.binary) return { model: null, error: 'This file is binary and cannot be displayed.' }
  if (r.tooLarge) return { model: null, error: 'This file is larger than 8 MB.' }
  const again = getModel(path)
  if (again) return { model: again }
  const model = monaco.editor.createModel(r.content, languageFor(path), monaco.Uri.parse(fileUri(path)))
  saved.set(model.uri.toString(), model.getAlternativeVersionId())
  return { model }
}

export function isDirty(model: monaco.editor.ITextModel): boolean {
  return saved.get(model.uri.toString()) !== model.getAlternativeVersionId()
}

export async function saveModel(path: string): Promise<void> {
  const model = getModel(path)
  if (!model) return
  await window.api.fs.writeFile(path, model.getValue())
  saved.set(model.uri.toString(), model.getAlternativeVersionId())
  markTab(path, false)
}

/** Pull fresh content from disk into a clean model, keeping undo history. */
export async function reloadIfClean(path: string): Promise<void> {
  const model = getModel(path)
  if (!model || isDirty(model)) return
  const r = await window.api.fs.readFile(path).catch(() => null)
  if (!r || r.binary || r.tooLarge) return
  if (r.content === model.getValue()) return
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: r.content }], () => null)
  saved.set(model.uri.toString(), model.getAlternativeVersionId())
}

export function disposeModel(path: string): void {
  const model = getModel(path)
  if (!model) return
  saved.delete(model.uri.toString())
  model.dispose()
}

export function markTab(path: string, dirty: boolean): void {
  const id = 'f:' + path.toLowerCase()
  useStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === id && t.kind === 'file' && t.dirty !== dirty ? { ...t, dirty } : t))
  }))
}

export { languageFor }

registerFileModels({ getModel, isDirty, disposeModel, reloadIfClean, saveModel, languageFor })
