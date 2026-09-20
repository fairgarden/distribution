import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: '@fairgarden/distribution',
  description: 'Ship a set of versioned modules together, and extend one distribution from another',
}

/**
 * Unstyled on purpose. The nav is here so every page has a way back, since the
 * pages themselves only cross-link within a section.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link> · <Link href="/overview">Overview</Link> ·{' '}
          <Link href="/commands">Commands</Link> ·{' '}
          <Link href="/functions">Functions</Link>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  )
}
