# arc-pi

ARC (Adaptive Refresh Cycle) for Pi: a safe-boundary session refresh extension that carries recent context into a fresh Pi session with a deterministic redacted handoff packet.

## Install

```bash
pi install git:github.com/12wqa/arc-pi
```

Or test a local checkout:

```bash
pi -e /path/to/arc-pi
```

## Commands

```text
/arc                 # status
/arc debug           # print raw ctx.getContextUsage() and ARC threshold math
/arc check           # evaluate current context and queue refresh if over threshold
/arc now             # create a safe-boundary ARC refresh now
/arc recommend       # show suggested settings for the current model
/arc 35%             # set refresh threshold and show current-model recommendation
/arc threshold 35%   # same as above; queues refresh if current context is already over threshold
/arc auto            # enable automatic threshold refresh
/arc manual          # disable automatic refresh; keep /arc now
/arc hydrate auto    # auto-submit the packet in the new session (default)
/arc hydrate draft   # draft the packet and wait for Enter instead
/arc draft           # shortcut for /arc hydrate draft
/arc replenish 1200  # transcript-line budget for the handoff packet
/arc instructions 300 # AGENTS.md/agent.md/CLAUDE.md line budget for the packet
/arc off             # disable ARC
/arc on              # enable ARC
/arc practical       # use practical window, default 200k tokens
/arc full            # use full model context window
/arc window 200000   # set practical window
/arc recent 20       # recent clean messages to consider before line budgeting
```

## Status-line display

When ARC is enabled, the Pi status line shows a compact graphical progress bar toward the next refresh threshold:

```text
ARC A ▰▰▰▱▱▱▱▱ 14k/40k
```

- `A` = automatic threshold refresh enabled
- `M` = manual-only mode
- filled blocks = current context progress toward the ARC refresh target
- `!` appears when the configured threshold has been crossed
- `↻N` appears during post-refresh cooldown turns

## How it works

The extension watches Pi context usage at `turn_end`. If the current context is over the configured threshold at that safe boundary, it queues rollover as a follow-up command so the current agent work can finish first. This does not require a fresh upward crossing; sessions that are already over threshold after install, reload, or reconfiguration are eligible for refresh. The rollover then:

1. waits for Pi to be idle;
2. builds a deterministic restart packet from recent non-system session messages;
3. redacts credential-like strings;
4. writes the packet to `~/.pi/agent/arc/packets/`;
5. starts a new Pi session with the old session recorded as parent;
6. either auto-submits the ARC packet in the replacement session (`/arc hydrate auto`) or places it in the editor for manual review (`/arc hydrate draft`).

ARC also copies ancestor `AGENTS.md`, `agent.md`, `CLAUDE.md`, and `GEMINI.md`-style instruction files into the packet within the `/arc instructions <lines>` budget. Pi should reload supported files from the new session cwd as normal; including them in the packet makes the handoff explicit.

This uses public Pi extension APIs rather than monkeypatching Pi internals.

## Context recommendations

See [`docs/context-reference.md`](docs/context-reference.md) for model-family degradation notes, OpenRouter metadata fields, a data-capture schema, and the recommendation table used by `/arc recommend`.

## Development

```bash
npm install
npm run typecheck
npm run pack:check
```

## Safety notes

ARC packets exclude system prompts and redact common API-key/token/secret shapes as `[REDACTED]`. Redaction is a safety net, not a reason to paste real secrets into chat.

## Troubleshooting

### `/arc now` exits instead of staying in Pi

That is not the intended behavior. `/arc now` should switch to a new Pi session and keep the TUI open. In auto-hydrate mode it submits the packet automatically; in draft mode it places the packet in the editor. If your terminal returns to the shell, restart Pi and use `/resume`. Packet audit copies live under:

```text
~/.pi/agent/arc/packets/
```

If it keeps happening, disable automatic ARC while debugging:

```text
/arc manual
```
