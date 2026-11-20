#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "markdown>=3.5",
# ]
# ///
"""Generate study/exams/<slug>/guide.html so the Guide view can show the official exam guide inline.

Each exam's guide Markdown (a text extraction of the official PDF) is cleaned of
extraction artifacts and rendered to HTML at BUILD TIME, so the browser needs no
Markdown parser and the app stays fully offline. The wording is never changed.
Only layout artifacts are repaired:

  * running page headers ("Claude Certification Program", "Exam guide") dropped
  * a paragraph split mid-sentence by a page break is re-joined
  * the blueprint table's duplicated header row and its "Total" row are repaired
  * the flattened "Document Control" block is rebuilt as a table

The guide Markdown files in study/exams/<slug>/ are kept already clean (a test checks
that cleaning them again changes nothing), so this pass only matters when a freshly
extracted guide is dropped in. tests/test_study_data.py also checks that no words were
added or lost. Re-run whenever a guide's Markdown changes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import markdown

__version__ = "1.2.0"

STUDY = Path(__file__).resolve().parent.parent
EXAMS = STUDY / "exams"
OUT_NAME = "guide.html"

_MD_EXTENSIONS = ["tables", "sane_lists"]
_SCRIPT_RE = re.compile(r"<script.*?>.*?</script>", re.S | re.I)
PAGE_HEADER = "Claude Certification Program"


def _squash(line: str) -> str:
    """Line text with markup, pipes and spaces removed (to recognize running headers)."""
    return re.sub(r"[#|\s*_]", "", line)


_HEADER_SQUASHED = _squash(PAGE_HEADER)


def _is_page_header_line(line: str) -> bool:
    """A running page header: the program name or a bare lowercase "Exam guide", as plain text or a heading."""
    plain = re.sub(r"^#+\s*", "", line).strip()
    return plain == PAGE_HEADER or plain == "Exam guide"


def clean_markdown(text: str) -> str:
    """Repair PDF-extraction layout artifacts without changing any wording."""
    lines = [ln.rstrip() for ln in text.split("\n")]

    # 1. Running page headers, as lines or as the (possibly split-cell) header row of a table.
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if _is_page_header_line(line):
            i += 1
            continue
        if line.startswith("|") and _squash(line).startswith(_HEADER_SQUASHED) and i + 2 < len(lines):
            # Header row + separator are the running header; the next row is the real header.
            out.extend([lines[i + 2], lines[i + 1]])
            i += 3
            continue
        out.append(line)
        i += 1
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 2. Table fixes: soft line breaks inside cells; the "Total" row lost/gained empty cells.
    text = text.replace("<br>", " ")
    text = re.sub(r"^\|+[ \t]*(?:&#124;[ \t]*)?Total[ \t]*\|[ \t]*100%[ \t]*(?:\|[ \t]*)+$", "| | Total | 100% |", text, flags=re.M)

    # 3. Document Control block flattened to one fragment per paragraph.
    text = re.sub(
        r"Version\n\n(?P<v>[^\n]+)\n\nSummary of change\n\n(?P<s>.+?) Date (?P<d>[^\n]+?)\s*$",
        lambda m: f"| Version | Summary of change | Date |\n|---|---|---|\n| {m['v']} | {m['s']} | {m['d']} |\n",
        text,
        flags=re.S,
    )

    # 4. List items the extractor separated with blank lines become one tight list.
    text = re.sub(r"^((?:- |\d+\. )[^\n]*)\n\n(?=(?:- |\d+\. ))", r"\1\n", text, flags=re.M)

    # 5. A page break can split a sentence: its tail may come back as a lowercase heading or paragraph.
    text = re.sub(r"^#{1,6}\s+(?=[a-z])", "", text, flags=re.M)
    blocks = re.split(r"\n{2,}", text.strip("\n"))
    merged: list[str] = []
    plain = lambda s: not re.match(r"\s*([#|>*\-]|\d+\.)", s)  # noqa: E731
    for b in blocks:
        prev = merged[-1] if merged else ""
        if merged and re.match(r"[a-z]", b) and plain(prev) and plain(b):
            merged[-1] = prev + "\n" + b
        else:
            merged.append(b)
    return "\n\n".join(merged) + "\n"


_HEADING_LEVEL = {"1": "3", "2": "3", "3": "4", "4": "5", "5": "6", "6": "6"}


def render(text: str) -> str:
    html = markdown.markdown(clean_markdown(text), extensions=_MD_EXTENSIONS)
    html = _SCRIPT_RE.sub("", html)  # defensive: strip any raw <script>
    # The page's own <h1> is "Guide" and the card's <h2> is "Exam Guide": nest the guide's headings below them.
    html = re.sub(r"<(/?)h([1-6])(?=[ >])", lambda m: f"<{m[1]}h{_HEADING_LEVEL[m[2]]}", html)
    return html


def build(slugs: list[str] | None = None, check: bool = False) -> int:
    stale = 0
    for exam_json in sorted(EXAMS.glob("*/exam.json")):
        slug = exam_json.parent.name
        if slugs and slug not in slugs:
            continue
        exam = json.loads(exam_json.read_text(encoding="utf-8"))
        src = exam_json.parent / exam["guide"]
        html = render(src.read_text(encoding="utf-8"))
        dest = exam_json.parent / OUT_NAME
        if check:
            if not dest.exists() or dest.read_text(encoding="utf-8") != html:
                print(f"STALE  {dest.relative_to(STUDY)}")
                stale += 1
            continue
        dest.write_text(html, encoding="utf-8")
        print(f"wrote  {dest.relative_to(STUDY)}  ({len(html):,} bytes)")
    return 1 if stale else 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="build_guides.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Render each exam's guide Markdown to study/exams/<slug>/guide.html for the Guide view.",
        epilog=(
            "Examples:\n"
            "  # Regenerate every exam's guide.html:\n"
            "  uv run study/tools/build_guides.py\n\n"
            "  # Only CCAR-P:\n"
            "  uv run study/tools/build_guides.py --exam ccarp\n\n"
            "  # Exit 1 if any guide.html is out of date (no writes):\n"
            "  uv run study/tools/build_guides.py --check\n\n"
            "  # Print the version:\n"
            "  uv run study/tools/build_guides.py --version\n"
        ),
    )
    p.add_argument("--exam", action="append", metavar="SLUG", help="limit to this exam slug (repeatable)")
    p.add_argument("--check", action="store_true", help="verify instead of writing; exit 1 when stale")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    return p


def main() -> int:
    args = build_parser().parse_args()
    return build(args.exam, args.check)


if __name__ == "__main__":
    sys.exit(main())
