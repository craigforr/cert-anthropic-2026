# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claude certification exam-prep repository

Study materials for Anthropic's Claude certification exams, built to hold any number of exams. Current: **CCAR-F** (Claude Certified Architect – Foundations), **CCDV-F** (Claude Certified Developer – Foundations), and **CCAR-P** (Claude Certified Architect – Professional) — all complete. Use the official codes (CCAR-F, CCDV-F, CCAR-P) in user-facing text and the lowercase, hyphen-free slugs (`ccarf`, `ccdvf`, `ccarp`) in file/dir names, IDs, storage keys, and CLI values.

## Layout

- `study/exams/ccarf/anthropic-ccarf-exam-guide-2026-07.md` — the CCAR-F exam guide (5 domains, 30 task statements 1.1–5.6, 6 scenarios S1–S6). **Source of truth for all CCAR-F content.** (`-2026-06.md` is the superseded prior edition.) Each exam's guide lives in its `study/exams/<slug>/` dir.
- `labs/` — 25 hands-on CCAR-F labs + a shared offline test harness (`labs/_shared/`). See `labs/README.md`. The labs catalog is a shared component (`labs`); each exam's task statements pick the labs that drill them.
- `study/` — a local, offline, single-user study app (practice quiz, flashcards, concept explainers, browsable labs, readiness dashboard) plus CLI/TUI tools. See `study/README.md`.
- `BACKLOG.md` — the running task backlog (see below).
- `.working/` — gitignored scratch (reference PDFs, CLI/TUI quiz history). Not content.

## Commands

Everything runs through `uv`; `labs/` and `study/` are **separate uv projects** — run pytest from inside each.

```bash
# Study content + app integrity
cd study && uv run pytest
cd study && uv run pytest tests/test_study_data.py::test_every_distractor_has_a_rationale

# Labs (default target = starter/, i.e. learner work — unfinished starters fail by design)
cd labs && LAB_TARGET=solution uv run pytest                      # reference solutions, must be all green
cd labs && LAB_TARGET=solution uv run pytest lab-03-agentic-loop  # one lab
ANTHROPIC_API_KEY=... uv run pytest -m llm                        # opt-in semantic checks

# Run the app / tools
uv run study/serve.py [--port 8123] [--no-browser]               # opens /web/
uv run study/tools/build_labs.py                                  # regenerate study/content/labs.json
uv run study/tools/content_map.py [--orphans|--item q-0001]       # what uses which content; orphans
uv run study/tools/quiz.py --exam ccarf --set hard --shuffle --num 20   # CLI quiz (TUI: quiz_tui.py)
```

## Architecture

### Study app (`study/`)
- **Multi-exam data model: one shared pool + per-exam item maps** (design + rationale: the "Shared-pool design" note in `BACKLOG.md`):
  - **Pool components** — `study/content/*.json`, each registered in `study/content/components.json` as `{id, kind, version, file}`. One copy per component on disk. Pool items are exam-neutral: no `domain`/`task_statement` (a test enforces it). No exam owns content.
  - **Exams** — `study/exams/index.json` lists slugs (first = default); `study/exams/<slug>/exam.json` holds code/name/guide, `config` (coverage target, pass threshold), domains + weights (may be fractional; optional per-task weights must sum to their domain's), task statements (+ their labs), and `sections` pinning components by id + version range (`^1.0`). Pins are checked by tests, not at runtime. Every `exams/<slug>/` dir is validated structurally; only exams listed in `index.json` appear in the app and must meet coverage (an unlisted exam is in development).
  - **Item maps** — `study/exams/<slug>/map.json`: per kind (`questions`/`flashcards`/`concepts`), each pool item the exam uses → its task (`"q-0001": "1.1"`). Item-level on purpose (no topic tags): an exam contains only items chosen for it. It's the single source for loading (app + CLI/TUI derive domain/task from it) and for dependencies — `uv run study/tools/content_map.py [--orphans|--item ID]` reports what uses what and what's orphaned.
  - **Item IDs** are neutral, opaque, stable, globally unique per kind (`q-0001`, `fc-0001`, `concept-0001`) — progress is keyed by them. New items take the next free number. Removing or re-keying items is a breaking (major) component change; deleting an item an exam maps fails tests. `study/migrations/pool-ids-2026-10.json` (old `ccarf-…` IDs → pool IDs) is historical — never edit it.
  - Adding content: add items to a pool component and map them in each exam that uses them; a new component also needs registering in `components.json` (a test enforces registry ↔ disk sync) and pinning in each exam.
  - Exam slugs are lowercase, no hyphen (`ccarf`, `ccdvf`, `ccarp`); user-facing text uses the official codes (CCAR-F, CCDV-F, CCAR-P).
- **Data → UI:** schemas live in `study/schema/`. The Web UI (`web/app.js`, vanilla JS, no build step) boots from `app.json` + `exams/index.json` + `content/components.json`, loads the exam's `exam.json` + `map.json`, fetches every pinned component, and keeps only mapped items (tagged from the map). Routes are `#/<exam>/<view>`. `serve.py` exists only because browsers block `fetch()` over `file://`.
- **Question tiers** (`questions-standard/intermediate/hard`) are schema-identical. `correct` is a single letter, or a 2+-letter array for "Select N" multi-response items. Every distractor needs a rationale. Answer options are shuffled **at display time** in all three interfaces (web, CLI, TUI) — authored keys stay as written in the data; don't reorder options to "balance" them.
- **`labs.json` is generated**, not hand-edited: `build_labs.py` renders each lab's `README.md`/`SOLUTION.md` to HTML at build time (so the browser needs no Markdown parser). Re-run it whenever lab Markdown changes; tests check it covers every `labs/lab-*` dir.
- **CLI/TUI pairs:** `quiz_tui.py` imports `quiz.py` as `core` (likewise `flashcards_tui.py` → `flashcards.py`). Logic lives in the core module; TUI files only add rendering. All four resolve `--exam`/`--set` through the same manifests via `tools/exam_manifest.py`, which also owns the exam map lookup, per-exam history (`.working/{quiz,flashcards}_history_<exam>.json`), and the one-time history migrations (pre-multi-exam files; pre-pool IDs → pool IDs, with a `.v1.json` backup). `study/tests/test_tools.py` covers that plumbing with history redirected to a temp dir.
- **Version lockstep:** `study/app.json` `app_version` (the engine version — separate from component versions) must equal `study/pyproject.toml` `version` and `serve.py` `__version__` (tested). Bump all three together.
- Coverage targets come from each exam's `config`, applied to its `coverage_component`: either flat (`questions_per_task_target`, CCAR-F and CCAR-P) or weight-scaled (`questions_target_total` T: each task needs ⌈T × task weight / 100⌉ + 1, the +1 a safety margin; requires per-task weights; CCDV-F) and are counted through the exam's map; every pinned question tier needs ≥ 50 mapped questions and every task statement exactly one mapped concept.

### Labs (`labs/`)
- Each `lab-NN-slug/` has `starter/` and `solution/` exposing **the same module names and public API**; one `tests/test_labNN.py` runs against either, selected by `LAB_TARGET`.
- Tests import the module under test via `labkit.lab_module(__file__, "name")` — never a plain import. `labkit` evicts same-named sibling modules cached from other labs (multiple labs reuse bare module names like `agent_loop`); bypassing it causes cross-lab `sys.modules` collisions.
- `labs/conftest.py` puts `_shared/` on `sys.path`, auto-skips `llm` tests without a key; `pyproject.toml` excludes `-m llm` by default.
- Claude is mocked with `_shared/mock_anthropic.MockAnthropic` (scripted `responses=[...]` or a `router`, plus batch support; `client.calls` records requests). Learner code must take a `client` parameter (dependency injection), never construct `anthropic.Anthropic()` internally.
- Don't edit `_shared/` from within a lab. Full contract: `labs/_shared/README.md`.

## BACKLOG.md — consult and keep it current

`BACKLOG.md` tracks outstanding and completed work. Read it before starting feature work, and update it as items change.

- **IDs** are global and unique: `BL-NNN` (e.g. `BL-001`).
- Two top-level sections: **Open** and **Completed**. Open is split into **Fixes → Changes → Additions**.
- Default resolution order is per-section, top-down (Fixes first, then Changes, then Additions) — a guideline, not a rule; items may be done out of order.
- When an item is resolved (done, descoped, or tabled), move it from Open to **Completed** with a note on how it was resolved.

## Working conventions

- **Study content is schema-validated JSON** under `study/content/` + `study/exams/` — the single source of truth the web app and CLI/TUI tools read. Any content/schema change must keep `cd study && uv run pytest` green (schema + integrity + per-task coverage).
- **The study web app (`study/web/`) has zero runtime dependencies** and must stay fully offline (no external requests). Fonts are self-hosted via `study/tools/fetch_fonts.py`. Preserve this when adding features.
- **Labs tests** are deterministic and offline: `cd labs && uv run pytest` (reference solutions: `LAB_TARGET=solution uv run pytest`). See `labs/_shared/README.md`.
- **Runnable Python scripts** follow the user's conventions: PEP 723 inline metadata (`uv run`-able), `argparse` `-h/--help` with an Examples epilog, module-level `__version__` + `--version`. Config-only lab artifacts are exempt.
- **Ground exam content in the guide**, mirroring its sample-question style (correct answer + why each distractor is wrong).
- **Content counts are hardcoded in docs** (`README.md` "By the Numbers" + tier counts, `study/README.md`, test-pass counts). When adding/removing questions, flashcards, concepts, or code samples, update those numbers.
- `study/videos/` holds curated third-party video links per domain — Markdown only, not app data, not schema-validated.
