'use client'

import NextLink from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { CodeProviderLazy } from '@fairgarden/docs/CodeProvider'
import { ToastProvider } from '@fairgarden/design/feedback/toast'
import { NavigationBar } from '@fairgarden/design/navigation/navigation-bar'
import { SidebarNav } from '@fairgarden/design/navigation/sidebar-nav'
import { SearchDialog } from '@fairgarden/design/overlays/search-dialog'
import { DocsLayout, DocsLayoutDrawer } from '@fairgarden/design/page/docs-layout'
import { toSidebarItems } from '@fairgarden/design/utils/docs/toSidebarItems'
import { sitemap } from '../sitemap'

/** The sidebar's page tree: the sitemap's sections and their pages. */
const sidebarItems = toSidebarItems(sitemap)

/** Internal links go through the Next.js router. */
const renderLink = (href: string) => <NextLink href={href} />

/** The search index's source, read once when the dialog first mounts. */
const loadSitemap = () => import('../sitemap')

/**
 * The docs chrome around every page, composed from the design system:
 * the Docs Layout, with the Navigation Bar (the home link, the Search
 * Dialog over the sitemap, and the drawer's menu Button below the sidebar
 * threshold) and the Sidebar Navigation, which fills the column and the
 * drawer from the same items. The current page comes from the URL, so the
 * server HTML already marks it.
 *
 * `CodeProviderLazy` gives the code blocks the docs engine's client side,
 * and `ToastProvider` the toast bar their copy actions confirm in.
 *
 * A client layout, because the header and the sidebar take functions (the
 * link renderer, the sitemap loader, the router) that a server layout
 * cannot pass them.
 */
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname()
  const router = useRouter()
  return (
    <ToastProvider>
      <CodeProviderLazy>
        <DocsLayout
          header={
            <NavigationBar
              wide
              logo="FairGarden Distribution"
              logoLabel="FairGarden Distribution home"
              renderLink={renderLink}
              currentPath={pathname}
              search={
                <SearchDialog
                  sitemap={loadSitemap}
                  onNavigate={(href) => router.push(href)}
                  keyboardShortcut
                />
              }
              drawer={<DocsLayoutDrawer />}
            />
          }
          sidebar={<SidebarNav items={sidebarItems} currentPath={pathname} renderLink={renderLink} />}
        >
          {children}
        </DocsLayout>
      </CodeProviderLazy>
    </ToastProvider>
  )
}
