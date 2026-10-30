import React from 'react'
import ReactDOM from 'react-dom/client'
import { shouldSkipRendererCrashScreen } from './renderer-errors'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { startStatusPulse } from './statusPulse'

interface CrashDetails {
  title: string
  message: string
  stack?: string
}

function normalizeError(error: unknown, fallbackTitle: string): CrashDetails {
  if (error instanceof Error) {
    return {
      title: fallbackTitle,
      message: error.message || error.name,
      stack: error.stack
    }
  }

  return {
    title: fallbackTitle,
    message: typeof error === 'string' ? error : JSON.stringify(error, null, 2)
  }
}

function CrashScreen({ title, message, stack }: CrashDetails): React.ReactElement {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#101218',
        color: '#f3f4f6',
        padding: '24px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        boxSizing: 'border-box'
      }}
    >
      <h1 style={{ margin: '0 0 16px', fontSize: '18px' }}>{title}</h1>
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          lineHeight: 1.5
        }}
      >
        {message}
        {stack ? `\n\n${stack}` : ''}
      </pre>
    </div>
  )
}

class RendererErrorBoundary extends React.Component<{ children: React.ReactNode }, { crash: CrashDetails | null }> {
  state: { crash: CrashDetails | null } = { crash: null }

  static getDerivedStateFromError(error: unknown): { crash: CrashDetails | null } {
    // Never swallow a render error here: React re-renders the failed subtree, and a
    // second throw tears the whole root down to a blank window with no crash screen.
    // Monaco noise is filtered on window.error / unhandledrejection instead.
    return { crash: normalizeError(error, 'Renderer crashed while rendering') }
  }

  componentDidCatch(error: unknown): void {
    console.error('Renderer error boundary caught an error', error)
  }

  render(): React.ReactNode {
    if (this.state.crash) {
      return <CrashScreen {...this.state.crash} />
    }
    return this.props.children
  }
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Missing #root element')
}

const root = ReactDOM.createRoot(rootElement)

function renderCrash(details: CrashDetails): void {
  root.render(<CrashScreen {...details} />)
}

window.addEventListener('error', (event) => {
  // Do not replace the React tree for Monaco/ResizeObserver noise. root.render(CrashScreen)
  // unmounts AppProvider; the next mount can run with window.api undefined.
  if (shouldSkipRendererCrashScreen(event.error, event.message)) {
    event.preventDefault()
    console.warn('Ignoring renderer noise', event.error ?? event.message)
    return
  }
  const details = normalizeError(event.error ?? event.message, 'Unhandled renderer error')
  console.error('window.error', event.error ?? event.message)
  renderCrash(details)
})

window.addEventListener('unhandledrejection', (event) => {
  if (shouldSkipRendererCrashScreen(event.reason)) {
    event.preventDefault()
    console.warn('Ignoring renderer rejection noise', event.reason)
    return
  }
  const details = normalizeError(event.reason, 'Unhandled promise rejection')
  console.error('window.unhandledrejection', event.reason)
  renderCrash(details)
})

async function bootstrap(): Promise<void> {
  try {
    // Monaco is configured before anything can mount an editor, so the loader
    // never falls back to fetching it from the CDN. Both chunks load in parallel.
    const [{ default: App }] = await Promise.all([import('./App'), import('./monacoSetup')])
    root.render(
      <React.StrictMode>
        <RendererErrorBoundary>
          <App />
        </RendererErrorBoundary>
      </React.StrictMode>
    )
  } catch (error) {
    console.error('Failed to bootstrap renderer', error)
    renderCrash(normalizeError(error, 'Renderer bootstrap failed'))
  }
}

startStatusPulse()
void bootstrap()
