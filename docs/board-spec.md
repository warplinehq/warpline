# Warpline Board: UI Design Specification

> Design spec for the interactive Ink terminal board (board consumer).
> Defines interaction patterns, rendering constraints, and state persistence.

## Architecture

- **Engine process**: Writes events to `events.jsonl` (append-only, size-capped:
  `emitBoardEvent` trims the file to its newest 20,000 lines once it drifts past
  cap + 2,000 slack — atomic tmp+rename; 2026-08-19)
- **Board process**: Reads `events.jsonl`, renders Ink UI, writes `acknowledgements.json`
- **IPC**: File-based only. Zero shared stdout between engine and board. (D-22)
- **Persistence**: `acknowledgements.json` survives across sessions

## Data Files

| File | Format | Writer | Reader |
|------|--------|--------|--------|
| `<home>/state/events.jsonl` | JSON Lines (one BoardEvent per line) | Engine | Board |
| `<home>/state/acknowledgements.json` | JSON object (event_id -> ack state) | Board | Board, Engine |

## Noticeboard

### Purpose
Persistent log of all engine events. Items remain visible until acknowledged.

### Interaction Patterns
1. **Acknowledge**: Mark as seen. Disappears from active view, stays in history.
2. **Action**: Opens the associated task in the task board. Links via `task_id`.
3. **Defer**: Snooze with duration (1h, 4h, 1d, 1w). Reappears after expiry.

### Rendering Constraints (Ink)
- Each event renders as ONE line: `[severity-icon] [timestamp-short] [source] summary`
- Maximum summary width: 200 chars (enforced by BoardEventSchema)
- No nested objects in rendered fields — use `metadata_json` for extra data
- Severity icons: critical=red-circle, warning=yellow-triangle, info=blue-dot
- Scrollable list with keyboard navigation (up/down/enter)

## Task Board

### Purpose
Actionable items sorted by severity. Two task modes:

#### Guided Tasks (`action_type: 'guided'`)
- Present inline context from `context_json`
- Show selectable options (parsed from context_json)
- Choosing an option executes the handler and marks task complete

#### Self-Directed Tasks (`action_type: 'self_directed'`)
- Display context and instructions
- User performs work outside Warpline
- "Mark done" confirmation removes from active board

### Task States
```
pending -> active -> completed
                  -> deferred (with snooze expiry)
deferred -> pending (when snooze expires)
```

### Sorting
1. Critical severity first
2. Warning second
3. Info last
4. Within same severity: oldest first (FIFO)

### Rendering
- Each task: `[severity-icon] [age-badge] [source] summary [state-badge]`
- Age badge: "new", "2d", "1w" etc.
- State badge: colored label for current state
- Detail view on enter: shows full context, action options

## Refresh Behavior

After engine completes background work:
1. Engine writes new events to `events.jsonl`
2. Board detects file change (fs.watch or polling at 2s interval)
3. Board re-reads events, merges with acknowledgements
4. UI re-renders with new items highlighted

## Guardrails 

User-configurable via `warpline config`:
- `max_sends_per_day`: Cap on outreach emails per day
- `review_gate`: Require approval before any side-effect execution
- `quiet_hours`: Time window when no notifications/execution
- Stored in `<home>/preferences.json`

## Schema References

The board is the primary consumer of these schemas from `<home>/schemas/`:

| Schema | Used by | Purpose |
|--------|---------|---------|
| `BoardEventSchema` | Noticeboard | Validates each line of events.jsonl on read |
| `TaskItemSchema` | Task Board | Tracks active/deferred work items |
| `AcknowledgementsSchema` | Both | Persists user actions across sessions |
| `TaskState` | Task Board | State machine transitions |
| `ActionType` | Both | Maps keyboard actions to state mutations |

## Ink-Specific Constraints

These apply to all Phase 85 component implementations:

1. **No nested object props** — Ink's reconciler has known issues with nested objects causing stale renders. All component props must be flat scalars (strings, numbers, booleans).
2. **Single-line summaries** — `summary` fields are max 200 chars, enforced at schema level. Never render multi-line text in list items.
3. **No dynamic key generation** — Use stable, pre-computed keys (event_id, task_id) as React keys in list renders.
4. **Separate process for engine** — Board and engine MUST be separate processes. Zero shared stdout — any engine console output would corrupt the Ink TTY rendering.
5. **Polling over inotify** — Use a 2s polling interval rather than `fs.watch` for cross-platform compatibility (inotify is Linux-only; polling works in macOS terminals too).
