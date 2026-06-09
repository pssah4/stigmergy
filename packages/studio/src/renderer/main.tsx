// React root for Stigmergy Studio (FEAT-03-01). Mounts App into #root.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
