# ARC context reference

ARC is meant to keep an agent in a **premium operating state**, not merely prevent hard context overflow. Long-context models can accept very large prompts, but quality often degrades before the advertised limit because the model has to retrieve relevant state from a noisy transcript.

## Sources and what they can tell us

### OpenRouter model metadata

OpenRouter exposes model metadata at:

```text
https://openrouter.ai/api/v1/models
```

Useful fields include:

- `id`
- `name`
- `context_length`
- `top_provider.context_length`
- `top_provider.max_completion_tokens`
- `pricing`
- `supported_parameters`

This is useful for **capacity-aware recommendations**. It does not directly measure degradation, reasoning quality, or agentic reliability at different context depths.

### Long-context degradation research

The key qualitative finding from long-context research is that models often show retrieval degradation as context grows, especially for information placed in the middle of the prompt. See:

- *Lost in the Middle: How Language Models Use Long Contexts* (TACL 2024)
- *Context Length Alone Hurts LLM Performance Despite Perfect Retrieval* (EMNLP Findings 2025)

For ARC, the practical takeaway is: use advertised context length as a hard ceiling, but set ARC refresh much earlier to keep active task state compact and recent.

## Recommendation model

ARC has two knobs:

```text
/arc window <tokens>  # practical operating window
/arc <percent>        # threshold as percentage of that window
```

Refresh target:

```text
refresh_tokens = practical_window * threshold
```

Example:

```text
/arc practical
/arc window 100000
/arc 40%
```

This refreshes at about 40,000 tokens.

## Initial recommendation table

These are conservative starting points, designed for coding-agent sessions with tool calls and file diffs. Tune upward only after observing stable behavior.

| Model family | Typical advertised context | Practical ARC window | Threshold | Approx refresh | Confidence | Notes |
|---|---:|---:|---:|---:|---|---|
| Claude / Anthropic | 200k | 100k | 40% | 40k | observed-pattern | Good long-context behavior, but agent transcripts get noisy quickly. |
| Claude very-long-context | 500k-1M | 160k | 35% | 56k | metadata-derived | Do not confuse huge input capacity with premium tool-use state. |
| Gemini long-context | 1M+ | 200k | 35% | 70k | metadata-derived | Can tolerate large contexts; still keep active work in a clean band. |
| OpenAI GPT/o-series | 128k-400k | 80k | 45% | 36k | metadata-derived | Strong general default for coding-agent work. |
| Qwen / DeepSeek / Kimi / Moonshot | 64k-256k | 64k | 45% | 28.8k | fallback | Model and provider behavior varies; start conservative. |
| Llama / Mistral / local open models | 32k-128k | 32k | 55% | 17.6k | fallback | Smaller models usually degrade earlier with tool-heavy history. |
| Generic <=32k model | <=32k | 20k | 60% | 12k | metadata-derived | Higher percent is acceptable because the window is small. |
| Generic <=64k model | <=64k | 32k | 55% | 17.6k | metadata-derived | Good default for medium windows. |
| Generic long-context model | >=200k | 100k | 40% | 40k | fallback | Safe default when no family profile matches. |

## Data capture schema

Use this schema to collect real degradation observations over time:

```json
{
  "model_id": "anthropic/claude-sonnet-4.5",
  "provider": "openrouter",
  "advertised_context_tokens": 200000,
  "arc_window_tokens": 100000,
  "arc_threshold": 0.4,
  "refresh_tokens": 40000,
  "workload": "coding-agent/tool-use",
  "task_type": "refactor/debug/research/planning",
  "observed_tokens": 37500,
  "quality_state": "premium|good|degraded|failed",
  "symptoms": [
    "forgot_file_state",
    "repeated_tool_call",
    "missed_instruction",
    "lost_middle_context",
    "over_summarized",
    "context_overflow"
  ],
  "notes": "What happened and what setting seemed better",
  "date": "2026-05-17"
}
```

## Tuning rules

If the model feels degraded before ARC triggers, lower one of these:

```text
/arc window <smaller-token-window>
/arc <lower-percent>
```

If ARC refreshes too often and continuity is excellent, raise threshold gradually:

```text
/arc 45%
/arc 50%
```

Prefer changing threshold first. Change `window` when a whole model family needs a different premium band.

## Extension behavior

The extension currently embeds a small rule-based recommender matching the table above. It is intentionally conservative and offline. When the user runs:

```text
/arc
/arc recommend
/arc 45%
```

ARC shows the recommendation for the current Pi model. Future versions can fetch OpenRouter metadata and merge it with local observed results, but live network fetches are avoided for now so `/arc` remains fast and reliable.
