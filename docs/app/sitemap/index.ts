import { createSitemap } from '@fairgarden/docs/createSitemap'
import Overview from '../(lib)/overview/page.mdx'
import Commands from '../(lib)/commands/page.mdx'
import Functions from '../(lib)/functions/page.mdx'

// Sections in navigation order, each a section index the docs engine keeps.
export const sitemap = createSitemap(import.meta.url, { Overview, Commands, Functions })
