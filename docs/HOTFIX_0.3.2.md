# Hotfix 0.3.2 — CLI search + trustworthy context ranking

## Symptoms

1. `stellar search login` returned `Unknown command: search` even though the M3 usage examples described that command.
2. Chinese natural-language queries such as `如果我要修改登入流程，應該先看哪些檔案` could return unrelated high-importance files.
3. A query with no repository evidence could still return three files instead of admitting that nothing matched.

## Root causes

- The CLI exposed `stellar find` but did not register `stellar search` as an alias.
- The tokenizer only retained ASCII tokens. A Chinese query produced zero query tokens.
- `contextForTask()` still added graph importance to every file even when lexical/symbol evidence was zero, turning a failed search into an unrelated importance ranking.

## Fix

- `stellar search` is now the primary documented command; `stellar find` remains a backwards-compatible alias.
- Deterministic bilingual query expansion maps a small set of common Traditional/Simplified Chinese code concepts (for example `登入` -> `login/auth/authentication`) to indexed code terminology without calling an LLM.
- Normal task queries now require path/summary/symbol evidence before a file is eligible for `primary` results.
- No-evidence queries return empty `primary/related/tests`, `confidence: "none"`, and `noMatchReason` instead of fabricated recommendations.
- Architecture-overview queries such as `主要入口與核心模組` are treated separately and may use entry-point heuristics plus graph importance, because structural ranking is explicitly requested in that case.

## Token policy

The query expansion and ranking are deterministic and local. They add zero LLM tokens to index maintenance or query execution.
