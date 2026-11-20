# CCAR-F Hands-On Lab Program

A buildable, testable lab curriculum for the **Claude Certified Architect –
Foundations (CCAR-F)** exam. Working through these labs in order gives you hands-on
experience with *every* feature, property, concept, and topic in
[`../study/exams/ccarf/anthropic-ccarf-exam-guide-2026-11.md`](../study/exams/ccarf/anthropic-ccarf-exam-guide-2026-11.md) —
all 5 domains, 30 task statements, and 6 exam scenarios.

## How the Labs Work

Each `lab-NN-slug/` folder contains:

| File | Purpose |
|------|---------|
| `README.md` | Objective, background, numbered tasks, "done when", how to verify |
| `SOLUTION.md` | Reference approach, key decisions & why, walkthrough, common mistakes |
| `starter/` | Scaffold with `TODO`s — **you edit this** |
| `solution/` | Complete reference implementation (same public API as `starter/`) |
| `tests/` | Automated checks (deterministic pytest; a few semantic `llm` checks) |
| *config files* | `.mcp.json`, `.claude/rules/*`, `SKILL.md`, CI YAML, sample docs, etc. |

### Running the Tests

From this `labs/` directory (uses [`uv`](https://docs.astral.sh/uv/) — no manual venv):

```bash
uv run pytest lab-03-agentic-loop            # test YOUR work (starter/) for one lab
uv run pytest                                # test your work across all labs
LAB_TARGET=solution uv run pytest            # run the reference solutions (all green)
ANTHROPIC_API_KEY=sk-... uv run pytest -m llm   # add the optional semantic checks
```

The default run is **deterministic and offline** — labs mock the Claude API via
`_shared/mock_anthropic.py`, so you need no API key and pay nothing. A handful of
inherently semantic checks are marked `@pytest.mark.llm` and are skipped unless you
set `ANTHROPIC_API_KEY`. See [`_shared/README.md`](_shared/README.md) for the harness
contract.

### Suggested Workflow per Lab

1. Read the lab `README.md`; note its prerequisites.
2. Fill in `starter/` until `uv run pytest lab-NN-...` passes.
3. Compare against `SOLUTION.md` / `solution/` for the "why", not just the "what".

## The Lab Matrix

Ordered by dependency **tier**, then **difficulty** (1 novice → 10 advanced) ascending.
LOE = estimated hands-on effort.

### Tier 0 — Foundations (No Prerequisites)

| # | Lab | Task stmts | Diff | LOE |
|---|-----|-----------|:----:|:---:|
| L01 | [Claude API Fundamentals](lab-01-claude-api-fundamentals/) | API appendix | 1 | 0:45 |
| L02 | [Claude Code Config Foundations](lab-02-claude-code-config-foundations/) | 3.1, 2.5 | 2 | 1:30 |

### Tier 1 — Core Building Blocks

| # | Lab | Task stmts | Diff | LOE | Deps |
|---|-----|-----------|:----:|:---:|------|
| L03 | [Agentic Loop Fundamentals](lab-03-agentic-loop/) | 1.1 | 3 | 1:30 | L01 |
| L04 | [Structured Output via tool_use](lab-04-structured-output/) | 4.3 | 3 | 1:30 | L01 |
| L06 | [Few-shot Prompting & Explicit Criteria](lab-06-few-shot-and-criteria/) | 4.1, 4.2 | 3 | 1:30 | L01 |
| L08 | [Plan Mode, Direct Execution & Iterative Refinement](lab-08-plan-mode-and-refinement/) | 3.4, 3.5 | 3 | 1:30 | L02 |
| L05 | [Tool Interface Design & Disambiguation](lab-05-tool-interface-design/) | 2.1 | 4 | 1:15 | L01 |
| L07 | [Claude Code Rules, Commands & Skills](lab-07-rules-commands-skills/) | 3.2, 3.3 | 4 | 2:00 | L02 |

### Tier 2 — Intermediate

| # | Lab | Task stmts | Diff | LOE | Deps |
|---|-----|-----------|:----:|:---:|------|
| L13 | [Session State, Resumption & Forking](lab-13-session-state/) | 1.7 | 5 | 1:30 | L03 |
| L12 | [Escalation & Ambiguity Resolution](lab-12-escalation/) | 5.2 | 5 | 1:30 | L03, L06 |
| L09 | [Structured Error Responses & Tool Distribution](lab-09-errors-and-tool-distribution/) | 2.2, 2.3 | 5 | 2:00 | L03, L05 |
| L10 | [Validation, Retry & Feedback Loops](lab-10-validation-retry/) | 4.4 | 5 | 1:45 | L04 |
| L15 | [MCP Server Integration into Claude Code](lab-15-mcp-integration/) | 2.4 | 5 | 1:45 | L02, L05 |
| L17 | [Batch Processing Strategies](lab-17-batch-processing/) | 4.5 | 5 | 1:30 | L04 |
| L11 | [Agent SDK Hooks & Workflow Enforcement](lab-11-hooks-and-enforcement/) | 1.5, 1.4 | 6 | 2:00 | L03, L09 |
| L14 | [Context Management & Preservation](lab-14-context-management/) | 5.1, 5.4 | 6 | 2:00 | L03 |
| L16 | [Task Decomposition & Multi-pass Review](lab-16-decomposition-and-review/) | 1.6, 4.6 | 6 | 2:00 | L06 |
| L18 | [Human Review & Confidence Calibration](lab-18-human-review-calibration/) | 5.5 | 6 | 2:00 | L04, L10 |

### Tier 3 — Advanced / Multi-Agent

| # | Lab | Task stmts | Diff | LOE | Deps |
|---|-----|-----------|:----:|:---:|------|
| L21 | [Claude Code in CI/CD](lab-21-claude-code-cicd/) | 3.6 | 6 | 2:00 | L04, L07 |
| L19 | [Multi-Agent Coordinator–Subagent Orchestration](lab-19-multi-agent-orchestration/) | 1.2, 1.3 | 7 | 2:30 | L03, L09 |
| L20 | [Error Propagation & Provenance in Synthesis](lab-20-error-propagation-provenance/) | 5.3, 5.6 | 7 | 2:00 | L19, L09 |

### Tier 4 — Capstones (One per Scenario Cluster)

| # | Lab | Scenario / Exercise | Diff | LOE | Deps |
|---|-----|--------------------|:----:|:---:|------|
| L22 | [Capstone: Customer Support Resolution Agent](lab-22-capstone-support-agent/) | S1 / Ex1 | 8 | 3:00 | L11, L12, L14 |
| L23 | [Capstone: Structured Data Extraction Pipeline](lab-23-capstone-extraction-pipeline/) | S6 / Ex3 | 8 | 3:00 | L10, L17, L18 |
| L25 | [Capstone: Claude Code Team & CI Workflow](lab-25-capstone-team-workflow/) | S2, S4, S5 / Ex2 | 8 | 3:00 | L07, L08, L15, L21 |
| L24 | [Capstone: Multi-Agent Research System](lab-24-capstone-research-system/) | S3 / Ex4 | 9 | 3:30 | L19, L20 |

**Totals:** 25 labs · ~48 hours of hands-on effort.

## Traceability — Every Exam Item Is Covered

### Task Statements → Labs

| Domain | Task statement | Lab(s) |
|--------|----------------|--------|
| 1 | 1.1 Agentic loops | L03 |
| 1 | 1.2 Multi-agent coordinator–subagent | L19, L24 |
| 1 | 1.3 Subagent invocation & context passing | L19, L24 |
| 1 | 1.4 Multi-step workflows: enforcement & handoff | L11, L22 |
| 1 | 1.5 Agent SDK hooks | L11, L22 |
| 1 | 1.6 Task decomposition strategies | L16 |
| 1 | 1.7 Session state, resumption, forking | L13 |
| 2 | 2.1 Tool interface design | L05 |
| 2 | 2.2 Structured error responses | L09, L20 |
| 2 | 2.3 Tool distribution & tool_choice | L09, L04 |
| 2 | 2.4 MCP server integration | L15, L25 |
| 2 | 2.5 Built-in tools | L02 |
| 3 | 3.1 CLAUDE.md hierarchy & organization | L02 |
| 3 | 3.2 Slash commands & skills | L07, L25 |
| 3 | 3.3 Path-specific rules | L07 |
| 3 | 3.4 Plan mode vs direct execution | L08 |
| 3 | 3.5 Iterative refinement | L08 |
| 3 | 3.6 CI/CD integration | L21, L25 |
| 4 | 4.1 Explicit criteria / precision | L06, L16 |
| 4 | 4.2 Few-shot prompting | L06 |
| 4 | 4.3 Structured output via tool_use | L04 |
| 4 | 4.4 Validation, retry & feedback loops | L10, L23 |
| 4 | 4.5 Batch processing | L17, L23 |
| 4 | 4.6 Multi-instance & multi-pass review | L16 |
| 5 | 5.1 Conversation context preservation | L14, L22 |
| 5 | 5.2 Escalation & ambiguity resolution | L12, L22 |
| 5 | 5.3 Error propagation across agents | L20, L24 |
| 5 | 5.4 Large codebase exploration context | L14 |
| 5 | 5.5 Human review & confidence calibration | L18, L23 |
| 5 | 5.6 Provenance & uncertainty in synthesis | L20, L24 |

### Exam Scenarios → Capstones

| Scenario | Capstone |
|----------|----------|
| S1 Customer Support Resolution Agent | L22 |
| S2 Code Generation with Claude Code | L25 |
| S3 Multi-Agent Research System | L24 |
| S4 Developer Productivity with Claude | L25 |
| S5 Claude Code for Continuous Integration | L25 |
| S6 Structured Data Extraction | L23 |

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/) (drives all Python scripts and tests)
- [Claude Code](https://docs.claude.com/claude-code) for the config-oriented labs (L02, L07, L08, L15, L21, L25)
- Optional: an `ANTHROPIC_API_KEY` to exercise the live end-to-end and `-m llm` paths
