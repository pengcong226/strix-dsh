/**
 * Bundled skills — ships the Strix-derived methodology and vulnerability
 * knowledge packages with the bundle itself (no .dsh/skills directory setup
 * needed), registered through ctx.skills.register().
 *
 * The adapted skill bodies and manifest live in assets/skills/ and are
 * produced by scripts/adapt_skills.py from upstream Strix skills
 * (Apache-2.0; see NOTICE and each file's header).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

interface ManifestEntry {
  name: string
  description: string
  category: string
  upstream: string
  file: string
}

const SKILLS_DIR = fileURLToPath(new URL('../assets/skills/', import.meta.url))

export async function registerBundledSkills(ctx: Context): Promise<number> {
  const manifest = JSON.parse(
    await readFile(join(SKILLS_DIR, 'manifest.json'), 'utf8'),
  ) as ManifestEntry[]

  let registered = 0
  for (const entry of manifest) {
    const content = await readFile(join(SKILLS_DIR, entry.file), 'utf8')
    ctx.skills.register({
      name: entry.name,
      description: entry.description,
      content,
      source: 'bundled',
    })
    registered += 1
  }
  return registered
}
