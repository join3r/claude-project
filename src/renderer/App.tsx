import React from 'react'
import { AppProvider } from './context/AppContext'

export default function App(): React.ReactElement {
  return (
    <AppProvider>
      <div className="app">
        <div>State loaded</div>
      </div>
    </AppProvider>
  )
}
