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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { workspaceDir } from '../lib/util.js'

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
          if (!args.text) return 'REJECTED: text is required for save.'
          writeFileSync(path, args.text, 'utf8')
          return `Threat model saved (${args.text.length} chars). Amendments cleared — this is now the baseline.`
        }

        if (args.action === 'amend') {
          if (!args.text) return 'REJECTED: text is required for amend.'
          const header = exists
            ? readFileSync(path, 'utf8')
            : '# Threat Model\n\n_(no baseline existed; first amendment becomes the working model)_\n'
          const amended = `${header}\n\n## Amendment — ${new Date().toISOString()}\n\n${args.text}\n`
          writeFileSync(path, amended, 'utf8')
          return `Amendment appended to ${path}. Later agents inherit the correction.`
        }

        return `Unknown action "${args.action}". Use get | amend | save.`
      },
    }),
  )
}
