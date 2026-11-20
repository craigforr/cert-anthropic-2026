"""Deterministic, offline validation of the study content.

Content is one exam-neutral *pool* of reusable, versioned *components*
(study/content/, listed in components.json). *Exams* (study/exams/<slug>/
exam.json, listed in study/exams/index.json) pin components per section, and
each exam's map.json picks the pool items it uses and assigns each to one of
its task statements. Every file is validated against its JSON Schema, then
cross-checked:

- component integrity (valid answer keys, complete distractor rationales,
  neutral globally-unique IDs, resolvable lab links) — independent of which
  exams use them;
- exam integrity (weights, task statements, guide, lab links), pin integrity
  (pinned component exists, is the right kind, satisfies the pin's version
  range), and map integrity (every mapped item exists in a component the exam
  pins, every task is real) — parametrized over every exam directory, listed
  in the index or not (an unlisted exam is in development);
- coverage per listed exam, computed through its map (per-task question
  target, tier minimums, one concept per task statement);
- the BL-050 ID-migration file stays well-formed.

Mirrors the labs' philosophy: the content cannot silently break the web app.
"""

from __future__ import annotations

import html as htmllib
import json
import math
import re
import sys
import tomllib
from collections import Counter
from pathlib import Path

import jsonschema
import pytest

STUDY_ROOT = Path(__file__).resolve().parent.parent
CONTENT = STUDY_ROOT / "content"
EXAMS_DIR = STUDY_ROOT / "exams"
SCHEMA = STUDY_ROOT / "schema"
LABS_ROOT = STUDY_ROOT.parent / "labs"

MIN_QUESTIONS_PER_TIER = 50
KIND_SCHEMA = {
    "questions": "questions.schema.json",
    "flashcards": "flashcards.schema.json",
    "concepts": "concepts.schema.json",
    "labs": "labs.schema.json",
}
# Neutral pool-item IDs per mapped kind (also the map.json sections).
ID_PATTERN = {"questions": r"q-[0-9]{4,}", "flashcards": r"fc-[0-9]{4,}", "concepts": r"concept-[0-9]{4,}"}
MAPPED_KINDS = list(ID_PATTERN)
POOL_ID_MIGRATION = STUDY_ROOT / "migrations" / "pool-ids-2026-10.json"


def _no_duplicate_keys(pairs):
    keys = [k for k, _ in pairs]
    dupes = sorted({k for k in keys if keys.count(k) > 1})
    if dupes:
        raise ValueError(f"duplicate keys: {dupes}")
    return dict(pairs)


def _load(path: Path):
    # Duplicate object keys are an error, not last-one-wins: in a map.json a
    # duplicate would silently drop one of an item's task assignments.
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_no_duplicate_keys)


APP = _load(STUDY_ROOT / "app.json")
REGISTRY = _load(CONTENT / "components.json")
COMPONENTS = {c["id"]: c for c in REGISTRY["components"]}
ITEMS = {cid: _load(CONTENT / c["file"]) for cid, c in COMPONENTS.items() if (CONTENT / c["file"]).is_file()}
EXAM_INDEX = _load(EXAMS_DIR / "index.json")
EXAM_SLUGS = EXAM_INDEX["exams"]  # listed: shown in the app, must meet coverage
# Every exam directory, listed or not: an unlisted exam is in development
# (e.g. while its content is being written) but must still be well-formed.
ALL_EXAMS = sorted(p.parent.name for p in EXAMS_DIR.glob("*/exam.json"))
EXAMS = {slug: _load(EXAMS_DIR / slug / "exam.json") for slug in ALL_EXAMS}
MAPS = {slug: _load(EXAMS_DIR / slug / "map.json") for slug in ALL_EXAMS}


def _of_kind(kind: str) -> list[str]:
    return [cid for cid, c in COMPONENTS.items() if c["kind"] == kind]


def _task_ids(slug: str) -> set[str]:
    return {ts["id"] for ts in EXAMS[slug]["task_statements"]}


def _pinned(slug: str, section: str) -> list[str]:
    return [pin["component"] for pin in EXAMS[slug]["sections"][section]]


def _all_questions() -> list[dict]:
    return [q for cid in _of_kind("questions") for q in ITEMS[cid]]


def _mapped_in(slug: str, cid: str) -> list[tuple[dict, str]]:
    """(item, task) for each item of component `cid` that exam `slug` maps."""
    mapping = MAPS[slug][COMPONENTS[cid]["kind"]]
    return [(item, mapping[item["id"]]) for item in ITEMS[cid] if item["id"] in mapping]


def satisfies(version: str, spec: str) -> bool:
    """Exact (1.2.3) or caret (^1, ^1.2, ^1.2.3: same major and >= the given version)."""
    v = tuple(int(x) for x in version.split("."))
    if not spec.startswith("^"):
        return v == tuple(int(x) for x in spec.split("."))
    base = [int(x) for x in spec[1:].split(".")]
    base += [0] * (3 - len(base))
    return v[0] == base[0] and v >= tuple(base)


def test_satisfies_semantics():
    assert satisfies("1.0.0", "^1.0") and satisfies("1.4.2", "^1.2") and satisfies("1.2.0", "1.2.0")
    assert not satisfies("2.0.0", "^1.0") and not satisfies("1.1.9", "^1.2") and not satisfies("1.2.1", "1.2.0")


# --------------------------------------------------------------------------- #
# Schema validation                                                            #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "path, schema_file",
    [
        (STUDY_ROOT / "app.json", "app.schema.json"),
        (CONTENT / "components.json", "components.schema.json"),
        (EXAMS_DIR / "index.json", "exam-index.schema.json"),
    ],
    ids=lambda x: x.name if isinstance(x, Path) else x,
)
def test_manifest_matches_schema(path, schema_file):
    jsonschema.validate(instance=_load(path), schema=_load(SCHEMA / schema_file))


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_matches_schema(slug):
    jsonschema.validate(instance=EXAMS[slug], schema=_load(SCHEMA / "exam.schema.json"))


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_map_matches_schema(slug):
    jsonschema.validate(instance=MAPS[slug], schema=_load(SCHEMA / "exam-map.schema.json"))


@pytest.mark.parametrize("cid", list(COMPONENTS))
def test_component_matches_schema(cid):
    assert cid in ITEMS, f"{cid} → missing file content/{COMPONENTS[cid]['file']}"
    jsonschema.validate(instance=ITEMS[cid], schema=_load(SCHEMA / KIND_SCHEMA[COMPONENTS[cid]["kind"]]))


# --------------------------------------------------------------------------- #
# Version consistency — app.json's app_version (the engine version) is the    #
# single source of truth; pyproject.toml and serve.py must not drift from it. #
# --------------------------------------------------------------------------- #
def test_app_version_matches_pyproject():
    pyproject = tomllib.loads((STUDY_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == APP["app_version"]


def test_app_version_matches_serve_py():
    serve_py = (STUDY_ROOT / "serve.py").read_text(encoding="utf-8")
    match = re.search(r'^__version__ = "([^"]+)"', serve_py, re.MULTILINE)
    assert match, "serve.py must define __version__ = \"X.Y.Z\""
    assert match.group(1) == APP["app_version"]


# --------------------------------------------------------------------------- #
# Component registry — ids unique, every file registered, schemes real.        #
# --------------------------------------------------------------------------- #
def test_component_ids_and_files_unique():
    ids = [c["id"] for c in REGISTRY["components"]]
    files = [c["file"] for c in REGISTRY["components"]]
    assert len(ids) == len(set(ids)), "duplicate component ids"
    assert len(files) == len(set(files)), "two components share a file"


def test_every_content_file_is_registered():
    on_disk = {p.name for p in CONTENT.glob("*.json")} - {"components.json"}
    listed = {c["file"] for c in REGISTRY["components"]}
    assert on_disk == listed, f"components.json out of sync with study/content/ — on disk {on_disk}, listed {listed}"


# --------------------------------------------------------------------------- #
# Pool items — neutral IDs, globally unique per kind (progress history is     #
# keyed by item id, across every component); lab links resolve.               #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("kind", MAPPED_KINDS)
def test_item_ids_globally_unique_per_kind(kind):
    ids = [item["id"] for cid in _of_kind(kind) for item in ITEMS[cid]]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    assert not dupes, f"duplicate {kind} ids across components: {dupes}"


@pytest.mark.parametrize("cid", [cid for cid, c in COMPONENTS.items() if c["kind"] in ID_PATTERN])
def test_item_ids_neutral_and_labs_resolve(cid):
    pattern = ID_PATTERN[COMPONENTS[cid]["kind"]]
    for item in ITEMS[cid]:
        assert re.fullmatch(pattern, item["id"]), f"{cid}: {item['id']} isn't a neutral pool id"
        assert "domain" not in item and "task_statement" not in item, f"{cid}: {item['id']} carries exam tags"
        if item.get("lab"):
            assert (LABS_ROOT / item["lab"]).is_dir(), f"{cid}: {item['id']} → missing lab {item['lab']}"


def _correct_set(q):
    """correct is a single letter for a normal item, or a list of 2+ letters
    for a multi-response ('Select N') item."""
    correct = q["correct"]
    return set(correct) if isinstance(correct, list) else {correct}


def test_question_options_are_sequential_A_through_E():
    # 4 options (A-D) is the norm; multi-response items may have 5 (A-E).
    for q in _all_questions():
        keys = [o["key"] for o in q["options"]]
        assert keys == ["A", "B", "C", "D", "E"][: len(keys)], q["id"]


def test_correct_answer_is_a_real_option():
    for q in _all_questions():
        keys = {o["key"] for o in q["options"]}
        assert _correct_set(q) <= keys, q["id"]


def test_every_distractor_has_a_rationale():
    for q in _all_questions():
        option_keys = {o["key"] for o in q["options"]}
        expected = option_keys - _correct_set(q)
        got = set(q["rationale"]["distractors"].keys())
        assert got == expected, f"{q['id']}: distractor rationales {got} != {expected}"


def test_no_answer_length_tell():
    # A single correct option longer than every distractor lets a learner guess
    # by length alone (BL-039 for Hard, BL-058 for Standard/Intermediate); 1.1x
    # keeps "pick the longest" near chance across a quiz.
    tells = []
    for q in _all_questions():
        if isinstance(q["correct"], list):
            continue
        lengths = {o["key"]: len(o["text"]) for o in q["options"]}
        key = lengths.pop(q["correct"])
        if all(key >= 1.1 * n for n in lengths.values()):
            tells.append(q["id"])
    assert not tells, f"correct option is >= 1.1x longer than every distractor: {tells}"


def test_labs_cover_every_lab_dir():
    lab_dirs = sorted(d.name for d in LABS_ROOT.glob("lab-*") if d.is_dir())
    indexed = sorted(l["slug"] for cid in _of_kind("labs") for l in ITEMS[cid])
    assert indexed == lab_dirs, "labs component out of sync with labs/ — run tools/build_labs.py"


def test_labs_slugs_resolve_and_have_content():
    for cid in _of_kind("labs"):
        for l in ITEMS[cid]:
            assert (LABS_ROOT / l["slug"]).is_dir(), l["slug"]
            assert l["readme_html"].strip(), f"{l['slug']} has empty readme_html"


# --------------------------------------------------------------------------- #
# Exam integrity                                                               #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_identity_and_guide(slug):
    exam = EXAMS[slug]
    assert exam["slug"] == slug, f"exams/{slug}/exam.json declares slug {exam['slug']!r}"
    assert exam["code"].replace("-", "").lower() == slug, f"{exam['code']} doesn't match slug {slug}"
    assert (EXAMS_DIR / slug / exam["guide"]).is_file(), f"{slug}: missing guide {exam['guide']}"


# --------------------------------------------------------------------------- #
# Guide view: overview facts + the generated inline exam guide                 #
# --------------------------------------------------------------------------- #
sys.path.insert(0, str(STUDY_ROOT / "tools"))
import build_guides  # noqa: E402

# Exams whose Guide view shows the guide inline. Add a slug here once its
# guide.html is built and reviewed; every other exam falls back to a PDF link.
GUIDE_INLINE = ["ccarp", "ccdvf", "ccarf", "ccdvp"]


def _words(text: str, html: bool = False) -> Counter:
    if html:
        text = re.sub(r"<[^>]+>", " ", text)
    text = htmllib.unescape(text.replace("<br>", " "))
    return Counter(re.findall(r"\w+", text.lower()))



@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_guide_source_is_clean(slug):
    """Guide Markdown is kept free of PDF-extraction artifacts (running page headers,
    split paragraphs, <br> in cells, loose lists): cleaning it again changes nothing."""
    src = (EXAMS_DIR / slug / EXAMS[slug]["guide"]).read_text(encoding="utf-8")
    assert build_guides.clean_markdown(src).strip() == src.strip(), (
        f"{slug}: guide still has extraction artifacts; run build_guides.clean_markdown on it"
    )


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_overview_facts_appear_in_guide(slug):
    ov = EXAMS[slug].get("overview")
    if not ov:
        pytest.skip("no overview authored")
    md = (EXAMS_DIR / slug / EXAMS[slug]["guide"]).read_text(encoding="utf-8")
    for fact in ov["facts"]:
        assert fact["value"] in md, f"{slug}: overview fact {fact} is not in the guide"


@pytest.mark.parametrize("slug", GUIDE_INLINE)
def test_guide_html_is_current(slug):
    src = (EXAMS_DIR / slug / EXAMS[slug]["guide"]).read_text(encoding="utf-8")
    built = EXAMS_DIR / slug / build_guides.OUT_NAME
    assert built.is_file(), f"{slug}: run `uv run study/tools/build_guides.py`"
    assert built.read_text(encoding="utf-8") == build_guides.render(src), (
        f"{slug}: guide.html is stale; run `uv run study/tools/build_guides.py`"
    )


@pytest.mark.parametrize("slug", GUIDE_INLINE)
def test_guide_html_changes_only_layout_artifacts(slug):
    """The inline guide is verbatim: the only words removed are the PDF's running
    headers, and nothing is added."""
    src = (EXAMS_DIR / slug / EXAMS[slug]["guide"]).read_text(encoding="utf-8")
    out = (EXAMS_DIR / slug / build_guides.OUT_NAME).read_text(encoding="utf-8")
    # Numbered-list markers ("1.") become <ol> numbering, not text.
    src = src.replace("Claude C|ertification Program", build_guides.PAGE_HEADER)  # a header split across table cells
    before, after = _words(re.sub(r"^\d+\.\s", "", src, flags=re.M)), _words(out, html=True)
    assert not (after - before), f"{slug}: words added: {after - before}"
    removed = before - after
    # Running headers: each is one "Claude Certification Program", and "Exam guide" where the
    # PDF repeated it (as its own line or a table-header cell).
    headers = src.count(build_guides.PAGE_HEADER)
    exam_guides = len(re.findall(r"(?:^|\|)[ #]*Exam guide[ ]*(?:\||$)", src, flags=re.M))
    allowed = Counter({w: n * headers for w, n in _words(build_guides.PAGE_HEADER).items()})
    allowed += Counter({"exam": exam_guides, "guide": exam_guides})
    assert not (removed - allowed), f"{slug}: words lost beyond page headers: {removed - allowed}"


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_domains_and_tasks(slug):
    exam = EXAMS[slug]
    domain_ids = [d["id"] for d in exam["domains"]]
    task_ids = [ts["id"] for ts in exam["task_statements"]]
    assert sum(d["weight"] for d in exam["domains"]) == pytest.approx(100)
    assert len(domain_ids) == len(set(domain_ids)), "duplicate domain ids"
    assert len(task_ids) == len(set(task_ids)), "duplicate task-statement ids"
    for ts in exam["task_statements"]:
        assert ts["domain"] in domain_ids, ts
        assert ts["id"].startswith(f"{ts['domain']}."), ts
        for lab in ts["labs"]:
            assert (LABS_ROOT / lab).is_dir(), f"{slug} {ts['id']} → missing lab {lab}"


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_task_weights_sum_to_domain_weights(slug):
    # Task/skill weights are optional (CCAR-F's guide doesn't give them), but
    # when an exam gives them, it gives every one, and each domain's add up.
    tasks = EXAMS[slug]["task_statements"]
    weighted = [ts for ts in tasks if "weight" in ts]
    if not weighted:
        return
    assert len(weighted) == len(tasks), f"{slug}: some task statements have a weight and some don't"
    for d in EXAMS[slug]["domains"]:
        total = sum(ts["weight"] for ts in tasks if ts["domain"] == d["id"])
        assert total == pytest.approx(d["weight"]), f"{slug}: domain {d['id']} task weights sum to {total}, not {d['weight']}"


def test_index_lists_only_real_exams():
    assert set(EXAM_SLUGS) <= set(ALL_EXAMS), f"exams/index.json lists missing exams: {set(EXAM_SLUGS) - set(ALL_EXAMS)}"


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_pins_resolve(slug):
    for section, pins in EXAMS[slug]["sections"].items():
        ids = [pin["component"] for pin in pins]
        assert len(ids) == len(set(ids)), f"{slug}.{section}: a component is pinned twice"
        for pin in pins:
            comp = COMPONENTS.get(pin["component"])
            assert comp, f"{slug}.{section}: unknown component {pin['component']!r}"
            assert comp["kind"] == section, f"{slug}.{section}: {comp['id']} is a {comp['kind']} component"
            assert satisfies(comp["version"], pin["version"]), (
                f"{slug}.{section}: {comp['id']} is {comp['version']}, pin requires {pin['version']}"
            )


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_exam_map_entries_resolve(slug):
    # Every mapped item exists in a component the exam pins for that kind, and
    # counts toward a real task statement. This is also what makes deleting an
    # item an exam still uses fail loudly.
    tasks = _task_ids(slug)
    for kind in MAPPED_KINDS:
        pinned_ids = {item["id"] for cid in _pinned(slug, kind) for item in ITEMS[cid]}
        for item_id, task in MAPS[slug][kind].items():
            assert item_id in pinned_ids, f"{slug} map.{kind}: {item_id} isn't in any {kind} component {slug} pins"
            assert task in tasks, f"{slug} map.{kind}: {item_id} → unknown task {task}"


@pytest.mark.parametrize("slug", EXAM_SLUGS)
def test_every_pinned_component_is_used(slug):
    # A pin whose component contributes no mapped items is dead weight (and
    # would show the user an empty set picker entry).
    for kind in MAPPED_KINDS:
        for cid in _pinned(slug, kind):
            assert _mapped_in(slug, cid), f"{slug}: pins {cid} but maps none of its items"


def test_pool_id_migration_file_is_well_formed():
    # Historical (BL-050): old exam-prefixed IDs → neutral pool IDs. Targets
    # aren't required to still exist (items may be retired later), but the map
    # must stay one-to-one so no two old records collapse into one.
    mig = _load(POOL_ID_MIGRATION)
    old_patterns = {"questions": r"ccarf-q-[0-9]+\.[0-9]+-[0-9]{3}", "flashcards": r"ccarf-fc-[0-9]+\.[0-9]+-[0-9]{3}",
                    "concepts": r"ccarf-concept-[0-9]+\.[0-9]+"}
    for kind in MAPPED_KINDS:
        pairs = mig[kind]
        assert pairs and len(set(pairs.values())) == len(pairs), f"{kind}: migration map isn't one-to-one"
        for old, new in pairs.items():
            assert re.fullmatch(old_patterns[kind], old) and re.fullmatch(ID_PATTERN[kind], new), (old, new)
    assert len(set(mig["components"].values())) == len(mig["components"])


# --------------------------------------------------------------------------- #
# Coverage, per exam                                                           #
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("slug", EXAM_SLUGS)
def test_each_question_tier_meets_minimum(slug):
    counts = {cid: len(_mapped_in(slug, cid)) for cid in _pinned(slug, "questions")}
    shortfalls = {cid: n for cid, n in counts.items() if n < MIN_QUESTIONS_PER_TIER}
    assert not shortfalls, f"{slug}: tiers below the {MIN_QUESTIONS_PER_TIER}-question minimum: {shortfalls}"


@pytest.mark.parametrize("slug", EXAM_SLUGS)
def test_question_coverage_meets_target(slug):
    # Scoped to the exam's coverage_component (CCAR-F: the Standard tier) — the
    # per-task target was calibrated against it; other tiers have their own
    # (lower) bars (see BL-031 in BACKLOG.md).
    config = EXAMS[slug]["config"]
    assert config["coverage_component"] in _pinned(slug, "questions"), f"{slug}: coverage_component isn't pinned"
    counts = {tid: 0 for tid in _task_ids(slug)}
    for _, task in _mapped_in(slug, config["coverage_component"]):
        counts[task] += 1
    targets = _question_targets(EXAMS[slug])
    shortfalls = {tid: f"{n}/{targets[tid]}" for tid, n in counts.items() if n < targets[tid]}
    assert not shortfalls, f"{slug}: task statements below their question target: {shortfalls}"


def _question_targets(exam):
    """Per-task question target: flat, or scaled by task weight plus a margin of one."""
    config = exam["config"]
    if "questions_per_task_target" in config:
        return {t["id"]: config["questions_per_task_target"] for t in exam["task_statements"]}
    total = config["questions_target_total"]
    # round() first so float noise (e.g. 150 * 4.1 / 100) can't push ceil() up a whole question.
    return {t["id"]: math.ceil(round(total * t["weight"] / 100, 6)) + 1 for t in exam["task_statements"]}


@pytest.mark.parametrize("slug", ALL_EXAMS)
def test_scaled_target_needs_task_weights(slug):
    exam = EXAMS[slug]
    if "questions_target_total" in exam["config"]:
        missing = [t["id"] for t in exam["task_statements"] if "weight" not in t]
        assert not missing, f"{slug}: questions_target_total needs every task weighted; unweighted: {missing}"


@pytest.mark.parametrize("slug", EXAM_SLUGS)
def test_exactly_one_concept_per_task_statement(slug):
    seen = [task for cid in _pinned(slug, "concepts") for _, task in _mapped_in(slug, cid)]
    assert len(seen) == len(set(seen)), f"{slug}: more than one concept per task statement"
    missing = _task_ids(slug) - set(seen)
    assert not missing, f"{slug}: missing concept explainers for: {sorted(missing)}"
