/**
 * strix_threat_model — the scan's shared threat model from Strix: who the
 * attacker is, where trust boundaries sit, what counts as critical. Get it
 * before testing; amend it when testing disproves it — "amending is not
 * optional politeness: a model nobody corrects turns the first agent's
 * guesses into everyone's assumptions." Scoped to this workspace, nothing
 * carries over between engagements.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { workspaceDir, writeFileAtomic } from '../lib/util.js'

const FILE = 'threat-model.md'

function threatModelPath(config: ConfigType): string {
  return join(workspaceDir(config), FILE)
}

export function registerThreatModel(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_threat_model',
      description:
        'Shared threat model for this engagement. action=get: read it before testing — if none exists yet, derive ' +
        'one (attacker profile, trust boundaries, critical assets) and save it. action=amend: record a correction ' +
        'when your testing disproves part of the model (a "trusted" boundary is attacker-reachable, an unlisted ' +
        'role/host/endpoint). action=save: replace the whole document (establishing baseline or folding ' +
        'amendments in — normally the orchestrator).',
      parameters: {
        action: { type: 'string', required: true, description: 'get | amend | save' },
        text: { type: 'string', description: 'Model text (save) or correction (amend).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>): Promise<string> {
        const args = raw as unknown as { action: string; text?: string }
        const path = threatModelPath(config)
        const exists = existsSync(path)

        if (args.action === 'get') {
          if (!exists) {
            return 'No threat model yet for this engagement. Derive one before testing — attacker profile, trust '
              + 'boundaries, roles, critical assets, what counts as critical here — and save it so every later '
              + 'agent inherits it instead of re-guessing.'
          }
          return readFileSync(path, 'utf8')
        }

        if (args.action === 'save') {
          if (!String(args.text ?? '').trim()) return 'REJECTED: text is required for save (blank text does not count).'
          await writeFileAtomic(path, String(args.text))
          return `Threat model saved (${String(args.text).length} chars). Amendments cleared — this is now the baseline.`
        }

        if (args.action === 'amend') {
          if (!String(args.text ?? '').trim()) return 'REJECTED: text is required for amend (blank text does not count).'
          const section = `## Amendment — ${new Date().toISOString()}\n\n${String(args.text)}\n`
          if (!exists) {
            // First amendment becomes the working model (atomic: it is the whole file).
            await writeFileAtomic(path, `# Threat Model\n\n_(no baseline existed; first amendment becomes the working model)_\n\n${section}`)
          } else {
            // Append-only: concurrent amends from parallel agents each land
            // as their own section instead of last-writer-wins swallowing one.
            appendFileSync(path, `\n${section}`, 'utf8')
          }
          return `Amendment appended to ${path}. Later agents inherit the correction.`
        }

        return `REJECTED: unknown action "${args.action}". Use get | amend | save.`
      },
    }),
  )
}
