import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// electron-vite 5+: main/preload deps are externalized by default (build.externalizeDeps)
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: { '@': resolve('src/renderer/src') }
    },
    // React Compiler: auto-memoizes components/hooks, so re-renders skip unchanged subtrees
    plugins: [react(), babel({ presets: [reactCompilerPreset()] })]
  }
})
