import type { Metadata } from 'next'
import '@fairgarden/design/utils/global.css'
import '@fairgarden/design/utils/fonts'
import { ClientProvider } from '@fairgarden/design/utils/ClientProvider'

export const metadata: Metadata = {
  title: '@fairgarden/distribution',
  description: 'Ship a set of versioned modules together, and extend one distribution from another',
}

/**
 * The document: the design system's global stylesheet (tokens, the Radix
 * scales, the follow-OS mode and the roles), its self-hosted fonts with their
 * metric-matched fallbacks, and `ClientProvider`, which gives the components
 * the locale and its direction. The docs chrome is the `(lib)` layout.
 */
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ClientProvider locale="en-US">{children}</ClientProvider>
      </body>
    </html>
  )
}
