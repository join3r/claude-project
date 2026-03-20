import React from 'react'
import ReactDOM from 'react-dom/client'
import './App.css'

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

  static getDerivedStateFromError(error: unknown): { crash: CrashDetails } {
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
  const details = normalizeError(event.error ?? event.message, 'Unhandled renderer error')
  console.error('window.error', event.error ?? event.message)
  renderCrash(details)
})

window.addEventListener('unhandledrejection', (event) => {
  const details = normalizeError(event.reason, 'Unhandled promise rejection')
  console.error('window.unhandledrejection', event.reason)
  renderCrash(details)
})

async function bootstrap(): Promise<void> {
  try {
    const { default: App } = await import('./App')
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

void bootstrap()
