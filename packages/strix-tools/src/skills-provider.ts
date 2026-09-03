/**
 * Bundled skills — ships the Strix-derived methodology and vulnerability
 * knowledge packages with the bundle itself (no .dsh/skills directory setup
 * needed), registered through ctx.skills.register().
 *
 * The adapted skill bodies and manifest live in assets/skills/ and are
 * produced by scripts/adapt_skills.py from upstream Strix skills
 * (Apache-2.0; see NOTICE and each file's header).
 *
 * Loading is fail-soft BY DESIGN: a missing/corrupt manifest or one unread
 * skill file logs a warning and continues. A bundle's assets must never be
 * able to take the whole dsh profile down at boot.
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

function warn(message: string): void {
  // eslint-disable-next-line no-console -- operator-visible load warning
  console.warn(`[strix-dsh-tools] skills warning: ${message}`)
}

export async function registerBundledSkills(ctx: Context, skillsDir: string = SKILLS_DIR): Promise<number> {
  let manifest: ManifestEntry[]
  try {
    manifest = JSON.parse(await readFile(join(skillsDir, 'manifest.json'), 'utf8')) as ManifestEntry[]
  } catch (err) {
    warn(`manifest.json unreadable — no bundled skills registered (${err instanceof Error ? err.message : String(err)})`)
    return 0
  }
  if (!Array.isArray(manifest)) {
    warn('manifest.json is not an array — no bundled skills registered.')
    return 0
  }

  const seen = new Set<string>()
  let registered = 0
  for (const entry of manifest) {
    if (!entry?.name || !entry.file) {
      warn(`skipping a manifest entry missing name/file: ${JSON.stringify(entry)?.slice(0, 120)}`)
      continue
    }
    if (seen.has(entry.name)) {
      warn(`skipping duplicate skill name "${entry.name}" (first registration wins).`)
      continue
    }
    try {
      const content = await readFile(join(skillsDir, entry.file), 'utf8')
      ctx.skills.register({
        name: entry.name,
        description: entry.description ?? '',
        content,
        source: 'bundled',
      })
      seen.add(entry.name)
      registered += 1
    } catch (err) {
      warn(`skill "${entry.name}" (${entry.file}) could not be read — skipped (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  if (registered === 0 && manifest.length > 0) {
    warn(`manifest listed ${manifest.length} skills but none registered — check assets/skills/.`)
  }
  return registered
}
