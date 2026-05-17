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
/arc now             # create a safe-boundary ARC handoff session now
/arc 35%             # set refresh threshold
/arc threshold 35%   # same as above
/arc auto            # enable automatic threshold refresh
/arc manual          # disable automatic refresh; keep /arc now
/arc off             # disable ARC
/arc on              # enable ARC
/arc practical       # use practical window, default 200k tokens
/arc full            # use full model context window
/arc window 200000   # set practical window
/arc recent 20       # recent clean messages to include in packet
```

## How it works

The extension watches Pi context usage at `turn_end`. When the configured threshold is crossed, it queues rollover as a follow-up command so the current agent work can finish first. The rollover then:

1. waits for Pi to be idle;
2. builds a deterministic restart packet from recent non-system session messages;
3. redacts credential-like strings;
4. writes the packet to `~/.pi/agent/arc/packets/`;
5. starts a new Pi session with the old session recorded as parent;
6. seeds the new session with the ARC packet as the first user message.

This uses public Pi extension APIs rather than monkeypatching Pi internals.

## Development

```bash
npm install
npm run typecheck
npm run pack:check
```

## Safety notes

ARC packets exclude system prompts and redact common API-key/token/secret shapes as `[REDACTED]`. Redaction is a safety net, not a reason to paste real secrets into chat.
