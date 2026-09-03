/**
 * strix_notes — the scan's shared scratchpad from Strix: durable cross-agent
 * facts that are neither findings nor coverage — working credentials,
 * endpoint inventories, tenant lists, rate-limit quirks the next agent needs.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigType } from '../config.js'
import { mirrorEvent } from '../lib/session-mirror.js'
import { safeId, workspaceSub } from '../lib/util.js'

interface Note {
  id: string
  title: string
  body: string
  created_at: string
  updated_at?: string
}

function notesDir(config: ConfigType): string {
  return workspaceSub(config, 'notes')
}

function readNotes(config: ConfigType): Note[] {
  const dir = notesDir(config)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Note)
}

export function registerNotes(ctx: Context, config: ConfigType) {
  ctx.tools.register(
    defineTool({
      name: 'strix_notes',
      description:
        'Shared cross-agent scratchpad. Write durable facts another agent needs: working credentials, endpoint ' +
        'inventories, tenant lists, rate-limit quirks, target quirks. Check list before recon so you build on ' +
        'what is already mapped instead of redoing it. Not for findings (use strix_finding) or coverage ' +
        '(use strix_coverage).',
      parameters: {
        action: { type: 'string', required: true, description: 'create | list | get | update | delete' },
        id: { type: 'string', description: 'Note id (get/update/delete).' },
        title: { type: 'string', description: 'Note title (create).' },
        body: { type: 'string', description: 'Note content (create/update).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value as string }],
      },
      async execute(raw: Record<string, unknown>, exec): Promise<string> {
        const args = raw as Record<string, unknown> & { action: string }
        const dir = notesDir(config)
        const notes = readNotes(config)

        if (args.action === 'list') {
          if (notes.length === 0) return 'No notes yet.'
          return notes.map((n) => `${n.id} ${n.title}${n.updated_at ? ' (updated)' : ''}`).join('\n')
        }
        if (args.action === 'get') {
          const id = String(args.id ?? '')
          if (!safeId(id)) return `REJECTED: bad note id "${id}".`
          const note = notes.find((n) => n.id === id)
          return note ? `${note.id} — ${note.title}\n\n${note.body}` : `Note ${id} not found.`
        }
        if (args.action === 'create') {
          if (!args.title || !args.body) return 'REJECTED: title and body are required.'
          const note: Note = {
            id: `N-${String(notes.length + 1).padStart(3, '0')}`,
            title: String(args.title),
            body: String(args.body),
            created_at: new Date().toISOString(),
          }
          writeFileSync(join(dir, `${note.id}.json`), JSON.stringify(note, null, 2), 'utf8')
          mirrorEvent(exec, 'strix/note', { action: 'create', note: { id: note.id, title: note.title, body: note.body } })
          return `Saved ${note.id}: ${note.title}.`
        }
        if (args.action === 'update') {
          const uid = String(args.id ?? '')
          if (!safeId(uid)) return `REJECTED: bad note id "${uid}".`
          const note = notes.find((n) => n.id === uid)
          if (!note) return `Note ${uid} not found.`
          if (args.title !== undefined) note.title = String(args.title)
          if (args.body !== undefined) note.body = String(args.body)
          note.updated_at = new Date().toISOString()
          writeFileSync(join(dir, `${note.id}.json`), JSON.stringify(note, null, 2), 'utf8')
          mirrorEvent(exec, 'strix/note', { action: 'update', note: { id: note.id, title: note.title, body: note.body } })
          return `Updated ${note.id}.`
        }
        if (args.action === 'delete') {
          const id = String(args.id ?? '')
          if (!safeId(id)) return `REJECTED: bad note id "${id}".`
          const file = join(dir, `${id}.json`)
          if (!existsSync(file)) return `Note ${id} not found.`
          rmSync(file)
          mirrorEvent(exec, 'strix/note', { action: 'delete', note: { id } })
          return `Deleted ${id} (only for notes that are wrong or superseded — living inventories should be updated, not recreated).`
        }
        return `Unknown action "${args.action}". Use create | list | get | update | delete.`
      },
    }),
  )
}
