import React, { createContext, useContext } from 'react'
import { useAppState, type AppActions } from '../hooks/useAppState'

const AppContext = createContext<AppActions | null>(null)

export function AppProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const state = useAppState()
  return <AppContext.Provider value={state}>{children}</AppContext.Provider>
}

export function useApp(): AppActions {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
