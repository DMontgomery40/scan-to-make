# SPDX-License-Identifier: MIT
"""SPDX licence normalization, text classification, and boolean expression evaluation."""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable

UNKNOWN = "UNKNOWN"
NON_COMMERCIAL = "NON-COMMERCIAL"
FIRST_PARTY = "FIRST-PARTY"

# Canonical mapping from common metadata strings (lowercased, collapsed whitespace)
# to normalized SPDX licence identifiers.
_CANONICAL_ALIASES: dict[str, str] = {
    "0bsd": "0BSD",
    "zero-clause bsd": "0BSD",
    "bsd zero clause license": "0BSD",
    "apache-2.0": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "apache 2": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache license, version 2.0": "Apache-2.0",
    "apache software license": "Apache-2.0",
    "asl 2.0": "Apache-2.0",
    "bsd-2-clause": "BSD-2-Clause",
    "bsd 2-clause": "BSD-2-Clause",
    "2-clause bsd": "BSD-2-Clause",
    "simplified bsd": "BSD-2-Clause",
    "bsd-2-clause license": "BSD-2-Clause",
    "bsd-3-clause": "BSD-3-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "3-clause bsd": "BSD-3-Clause",
    "new bsd": "BSD-3-Clause",
    "revised bsd": "BSD-3-Clause",
    "bsd-3-clause license": "BSD-3-Clause",
    "bsl-1.0": "BSL-1.0",
    "boost software license": "BSL-1.0",
    "boost software license 1.0": "BSL-1.0",
    "boost software license - version 1.0": "BSL-1.0",
    "blueoak-1.0.0": "BlueOak-1.0.0",
    "cc0-1.0": "CC0-1.0",
    "cc0 1.0": "CC0-1.0",
    "cc-by-4.0": "CC-BY-4.0",
    "cc by 4.0": "CC-BY-4.0",
    "cc-by-3.0": "CC-BY-3.0",
    "isc": "ISC",
    "isc license": "ISC",
    "isc license (iscl)": "ISC",
    "mit": "MIT",
    "mit license": "MIT",
    "the mit license": "MIT",
    "the mit license (mit)": "MIT",
    "expat": "MIT",
    "mpl-2.0": "MPL-2.0",
    "mozilla public license 2.0": "MPL-2.0",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "psf-2.0": "PSF-2.0",
    "python-2.0": "Python-2.0",
    "cnri-python": "CNRI-Python",
    "bzip2-1.0.6": "bzip2-1.0.6",
    "x11": "X11",
    "tcl": "TCL",
    "unicode-3.0": "Unicode-3.0",
    "icu": "ICU",
    "ftl": "FTL",
    "ijg": "IJG",
    "libpng": "Libpng",
    "libpng-2.0": "libpng-2.0",
    "libtiff": "libtiff",
    "licenseref-sqlite-public-domain": "LicenseRef-SQLite-Public-Domain",
    "python software foundation license": "PSF-2.0",
    "unlicense": "Unlicense",
    "the unlicense": "Unlicense",
    "zlib": "Zlib",
    "zlib/libpng license": "Zlib",
    "licenseref-tost-1.0": "LicenseRef-TOST-1.0",
    # Copyleft identifiers
    "gpl-1.0": "GPL-1.0-only",
    "gpl-1.0-only": "GPL-1.0-only",
    "gpl-1.0-or-later": "GPL-1.0-or-later",
    "gpl-2.0": "GPL-2.0-only",
    "gpl-2.0-only": "GPL-2.0-only",
    "gpl-2.0+": "GPL-2.0-or-later",
    "gpl-2.0-or-later": "GPL-2.0-or-later",
    "gplv2": "GPL-2.0-only",
    "gplv2+": "GPL-2.0-or-later",
    "gnu general public license v2 (gplv2)": "GPL-2.0-only",
    "gnu general public license v2 or later (gplv2+)": "GPL-2.0-or-later",
    "gpl-3.0": "GPL-3.0-only",
    "gpl-3.0-only": "GPL-3.0-only",
    "gpl-3.0+": "GPL-3.0-or-later",
    "gpl-3.0-or-later": "GPL-3.0-or-later",
    "gplv3": "GPL-3.0-only",
    "gplv3+": "GPL-3.0-or-later",
    "gnu general public license v3 (gplv3)": "GPL-3.0-only",
    "gnu general public license v3 or later (gplv3+)": "GPL-3.0-or-later",
    "lgpl-2.0": "LGPL-2.0-only",
    "lgpl-2.0-only": "LGPL-2.0-only",
    "lgpl-2.0+": "LGPL-2.0-or-later",
    "lgpl-2.0-or-later": "LGPL-2.0-or-later",
    "lgpl-2.1": "LGPL-2.1-only",
    "lgpl-2.1-only": "LGPL-2.1-only",
    "lgpl-2.1+": "LGPL-2.1-or-later",
    "lgpl-2.1-or-later": "LGPL-2.1-or-later",
    "lgplv2.1": "LGPL-2.1-only",
    "lgplv2.1+": "LGPL-2.1-or-later",
    "lgpl-3.0": "LGPL-3.0-only",
    "lgpl-3.0-only": "LGPL-3.0-only",
    "lgpl-3.0+": "LGPL-3.0-or-later",
    "lgpl-3.0-or-later": "LGPL-3.0-or-later",
    "lgplv3": "LGPL-3.0-only",
    "lgplv3+": "LGPL-3.0-or-later",
    "agpl-1.0": "AGPL-1.0-only",
    "agpl-1.0-only": "AGPL-1.0-only",
    "agpl-1.0-or-later": "AGPL-1.0-or-later",
    "agpl-3.0": "AGPL-3.0-only",
    "agpl-3.0-only": "AGPL-3.0-only",
    "agpl-3.0+": "AGPL-3.0-or-later",
    "agpl-3.0-or-later": "AGPL-3.0-or-later",
    "agplv3": "AGPL-3.0-only",
    "agplv3+": "AGPL-3.0-or-later",
    "gnu affero general public license v3": "AGPL-3.0-only",
    "gnu affero general public license v3 or later (agplv3+)": "AGPL-3.0-or-later",
}

_TROVE_CLASSIFIER_MAP: dict[str, str] = {
    "osi approved :: mit license": "MIT",
    "osi approved :: apache software license": "Apache-2.0",
    "osi approved :: bsd license": "BSD-3-Clause",
    "osi approved :: isc license (iscl)": "ISC",
    "osi approved :: mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "osi approved :: boost software license 1.0 (bsl-1.0)": "BSL-1.0",
    "osi approved :: python software foundation license": "PSF-2.0",
    "osi approved :: the unlicense (unlicense)": "Unlicense",
    "osi approved :: zlib/libpng license": "Zlib",
    "osi approved :: zero-clause bsd (0bsd)": "0BSD",
    "osi approved :: gnu general public license v2 (gplv2)": "GPL-2.0-only",
    "osi approved :: gnu general public license v2 or later (gplv2+)": "GPL-2.0-or-later",
    "osi approved :: gnu general public license v3 (gplv3)": "GPL-3.0-only",
    "osi approved :: gnu general public license v3 or later (gplv3+)": "GPL-3.0-or-later",
    "osi approved :: gnu lesser general public license v2 (lgplv2)": "LGPL-2.0-only",
    "osi approved :: gnu lesser general public license v2 or later (lgplv2+)": "LGPL-2.0-or-later",
    "osi approved :: gnu lesser general public license v2.1 (lgplv2.1)": "LGPL-2.1-only",
    "osi approved :: gnu lesser general public license v2.1 or later (lgplv2.1+)": "LGPL-2.1-or-later",
    "osi approved :: gnu lesser general public license v3 (lgplv3)": "LGPL-3.0-only",
    "osi approved :: gnu lesser general public license v3 or later (lgplv3+)": "LGPL-3.0-or-later",
    "osi approved :: gnu affero general public license v3": "AGPL-3.0-only",
    "osi approved :: gnu affero general public license v3 or later (agplv3+)": "AGPL-3.0-or-later",
    "cc0 1.0 universal (cc0 1.0) public domain dedication": "CC0-1.0",
}

# Identifiers that explicitly denote non-commercial licensing.
_NC_ID_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^cc-by-nc(?:-[a-z0-9.]+)*$", re.IGNORECASE),
    re.compile(r"^polyform-noncommercial(?:-[a-z0-9.]+)*$", re.IGNORECASE),
    re.compile(r"^prospero-public-license(?:-[a-z0-9.]+)*$", re.IGNORECASE),
    re.compile(r"^licenseref-.*(?:non-?commercial|(?:^|-)nc(?:-|$)).*$", re.IGNORECASE),
    re.compile(r"^non-?commercial$", re.IGNORECASE),
)

# Restrictive non-commercial clauses inside free-form licence texts.
# Permissive phrases such as "commercial or non-commercial" (Unlicense / Zlib) are
# stripped before matching so permissive public-domain dedications never false-trigger.
_PERMISSIVE_NC_PHRASES = re.compile(
    r"\bcommercial\s+(?:or|and|/)\s+non-?commercial\b|\bnon-?commercial\s+(?:or|and|/)\s+commercial\b",
    re.IGNORECASE,
)

_RESTRICTIVE_NC_TEXT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bnon-?commercial\s+(?:research\s+)?(?:use|purposes?)\s+only\b", re.IGNORECASE),
    re.compile(r"\bsolely\s+for\s+(?:academic|research|personal|educational|non-?commercial)[^.;\n]{0,80}\bnon-?commercial\b", re.IGNORECASE),
    re.compile(r"\bfor\s+(?:academic|research|educational|internal|personal)(?:\s*(?:,|and|or)\s*(?:academic|research|educational|internal|personal))*\s+(?:and\s+)?non-?commercial\b", re.IGNORECASE),
    re.compile(r"\bnot\s+for\s+commercial\s+(?:use|purposes?|distribution)\b", re.IGNORECASE),
    re.compile(r"\bcommercial\s+(?:use|exploitation|distribution)\s+is\s+(?:strictly\s+)?(?:prohibited|forbidden|not\s+permitted|excluded)\b", re.IGNORECASE),
    re.compile(r"\bmay\s+not\s+be\s+used\s+(?:for|in)\s+(?:any\s+)?commercial\b", re.IGNORECASE),
    re.compile(r"\bno\s+commercial\s+use\b", re.IGNORECASE),
    re.compile(r"\bcreative\s+commons\s+attribution-noncommercial\b", re.IGNORECASE),
    re.compile(r"\bpolyform\s+noncommercial\s+license\b", re.IGNORECASE),
    re.compile(r"\bnvidia\s+source\s+code\s+license(?:\s+for\s+[a-z0-9_-]+)?\b.*\bnon-?commercial\b", re.IGNORECASE | re.DOTALL),
)

_SPDX_HEADER_RE = re.compile(r"SPDX-License-Identifier:\s*([A-Za-z0-9.\-+() ]+)")


def has_non_commercial_restriction(text: str) -> bool:
    """Return True when licence text contains a restrictive non-commercial clause."""
    if not text:
        return False
    scrubbed = _PERMISSIVE_NC_PHRASES.sub(" ", text)
    return any(pattern.search(scrubbed) for pattern in _RESTRICTIVE_NC_TEXT_PATTERNS)


def is_non_commercial_id(token: str) -> bool:
    cleaned = token.strip()
    if not cleaned:
        return False
    if any(pattern.match(cleaned) for pattern in _NC_ID_PATTERNS):
        return True
    return has_non_commercial_restriction(cleaned)


def is_gpl_family(licence_id: str) -> bool:
    """Return True if a licence expression contains GPL, LGPL, or AGPL terms."""
    if not licence_id:
        return False
    tokens = re.findall(r"[A-Za-z0-9.\-+]+", licence_id)
    for tok in tokens:
        norm = normalize_single_token(tok)
        if norm.startswith(("GPL-", "LGPL-", "AGPL-")):
            return True
    return False


def normalize_single_token(raw: str) -> str:
    """Normalize a single licence identifier (not a compound expression)."""
    cleaned = " ".join(raw.strip().split())
    if not cleaned:
        return UNKNOWN
    lower = cleaned.lower()
    if lower in ("none", "null", "unknown", "unlicensed", "proprietary", "see license", "custom"):
        return UNKNOWN
    if is_non_commercial_id(cleaned):
        return NON_COMMERCIAL
    if lower in _CANONICAL_ALIASES:
        return _CANONICAL_ALIASES[lower]
    if re.match(r"^LicenseRef-[A-Za-z0-9.\-]+$", cleaned):
        return cleaned
    # Preserve syntactically valid SPDX-like tokens that aren't in our alias map
    # only if they match known SPDX casing; otherwise classify unknown strings cleanly.
    if re.match(r"^[A-Za-z0-9.\-+]+$", cleaned) and any(ch.isupper() or ch.isdigit() for ch in cleaned):
        return cleaned
    return UNKNOWN


def normalize_classifier(classifiers: Iterable[str]) -> str:
    """Extract normalized licence expression from Python Trove classifiers."""
    found: list[str] = []
    for clf in classifiers:
        parts = [p.strip() for p in clf.split("::")]
        if not parts or parts[0].lower() != "license":
            continue
        tail = " :: ".join(parts[1:]).lower()
        if "non-commercial" in tail or "noncommercial" in tail:
            return NON_COMMERCIAL
        if "proprietary" in tail:
            return UNKNOWN
        if tail in _TROVE_CLASSIFIER_MAP:
            mapped = _TROVE_CLASSIFIER_MAP[tail]
            if mapped not in found:
                found.append(mapped)
        elif len(parts) >= 2:
            last = normalize_single_token(parts[-1])
            if last != UNKNOWN and last not in found:
                found.append(last)
    if not found:
        return UNKNOWN
    if len(found) == 1:
        return found[0]
    return " AND ".join(found)


def extract_spdx_headers(texts: Iterable[str]) -> list[str]:
    """Extract normalized SPDX-License-Identifier headers from source files."""
    found: list[str] = []
    for text in texts:
        for match in _SPDX_HEADER_RE.finditer(text[:4096]):
            expr = normalize_expression(match.group(1).strip())
            if expr != UNKNOWN and expr not in found:
                found.append(expr)
    return found


def classify_licence_text(text: str, spdx_hints: Iterable[str] = ()) -> str:
    """Classify a full LICENSE / COPYING file into a normalized SPDX identifier."""
    if not text or not text.strip():
        return UNKNOWN

    # Always check restrictive non-commercial riders first to catch hybrid
    # "MIT/BSD header + non-commercial research only" wrapper files.
    if has_non_commercial_restriction(text):
        return NON_COMMERCIAL

    inline_spdx = extract_spdx_headers([text])
    if inline_spdx:
        return inline_spdx[0]

    normalized_ws = " ".join(text.split())
    lower = normalized_ws.lower()
    # Extract title/header before Terms & Conditions or GPL Section 13 cross-references
    title_cutoff = len(lower)
    for boundary in ("terms and conditions", "13. use with the gnu affero", "how to apply these terms"):
        pos = lower.find(boundary)
        if pos != -1:
            title_cutoff = min(title_cutoff, pos)
    preamble = lower[: min(title_cutoff, 600)]
    hints = list(spdx_hints)

    if "tomorrow open source technology license 1.0" in preamble or "tomorrow open source technology license 1.0" in lower:
        return "LicenseRef-TOST-1.0"

    if "gnu affero general public license" in preamble:
        if "version 3" in preamble:
            if "agpl-3.0-or-later" in [h.lower() for h in hints] or "either version 3 of the license, or (at your option) any later version" in lower:
                return "AGPL-3.0-or-later"
            return "AGPL-3.0-only"
        return "AGPL-1.0-only"

    if "gnu lesser general public license" in preamble or "gnu library general public license" in preamble:
        if "version 3" in preamble:
            return "LGPL-3.0-or-later" if "lgpl-3.0-or-later" in [h.lower() for h in hints] else "LGPL-3.0-only"
        if "version 2.1" in preamble:
            return "LGPL-2.1-or-later" if "lgpl-2.1-or-later" in [h.lower() for h in hints] else "LGPL-2.1-only"
        return "LGPL-2.0-only"

    if "gnu general public license" in preamble:
        if "version 3, 29 june 2007" in preamble or "version 3" in preamble:
            if any(h == "GPL-3.0-or-later" for h in hints):
                return "GPL-3.0-or-later"
            return "GPL-3.0-only"
        if "version 2, june 1991" in preamble or "version 2" in preamble:
            if any(h == "GPL-2.0-or-later" for h in hints):
                return "GPL-2.0-or-later"
            return "GPL-2.0-only"
        return "GPL-1.0-only"

    if "mozilla public license version 2.0" in lower:
        return "MPL-2.0"

    if "apache license" in lower and "version 2.0" in lower:
        return "Apache-2.0"

    if "boost software license - version 1.0" in lower or (
        "permission is hereby granted, free of charge, to any person or organization obtaining a copy of the software and accompanying documentation covered by this license"
        in lower
    ):
        return "BSL-1.0"

    if "permission is hereby granted, free of charge, to any person obtaining a copy" in lower and "without restriction, including without limitation the rights" in lower:
        return "MIT"

    if "permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted" in lower:
        if "the above copyright notice and this permission notice appear in all copies" in lower:
            return "ISC"
        return "0BSD"

    if "anyone is free to copy, modify, publish, use, compile, sell, or distribute this software" in lower and "public domain" in lower:
        return "Unlicense"

    if "the origin of this software must not be misrepresented" in lower and "altered source versions must be plainly marked as such" in lower:
        return "Zlib"

    if "redistribution and use in source and binary forms, with or without modification, are permitted" in lower:
        if "neither the name of" in lower or "nor the names of its contributors may be used to endorse or promote" in lower:
            return "BSD-3-Clause"
        return "BSD-2-Clause"

    if "creative commons attribution 4.0 international" in lower:
        return "CC-BY-4.0"

    if "cc0 1.0 universal" in lower:
        return "CC0-1.0"

    return UNKNOWN


# --- SPDX Boolean Expression Parser & Evaluator ---

@dataclass(frozen=True)
class _ExprNode:
    pass


@dataclass(frozen=True)
class _Atom(_ExprNode):
    licence: str


@dataclass(frozen=True)
class _And(_ExprNode):
    left: _ExprNode
    right: _ExprNode


@dataclass(frozen=True)
class _Or(_ExprNode):
    left: _ExprNode
    right: _ExprNode


_TOKEN_RE = re.compile(r"\(|\)|\bAND\b|\bOR\b|\bWITH\b|[^\s()]+")


def _tokenize_spdx(raw: str) -> list[str]:
    return _TOKEN_RE.findall(raw)


class _Parser:
    def __init__(self, tokens: list[str]) -> None:
        self.tokens = tokens
        self.pos = 0

    def peek(self) -> str | None:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else None

    def consume(self) -> str:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self) -> _ExprNode:
        node = self.parse_or()
        if self.pos != len(self.tokens):
            raise ValueError(f"Unexpected trailing token: {self.tokens[self.pos]}")
        return node

    def parse_or(self) -> _ExprNode:
        node = self.parse_and()
        while self.peek() == "OR":
            self.consume()
            right = self.parse_and()
            node = _Or(node, right)
        return node

    def parse_and(self) -> _ExprNode:
        node = self.parse_primary()
        while self.peek() == "AND":
            self.consume()
            right = self.parse_primary()
            node = _And(node, right)
        return node

    def parse_primary(self) -> _ExprNode:
        tok = self.peek()
        if tok is None:
            raise ValueError("Unexpected end of licence expression")
        if tok == "(":
            self.consume()
            inner = self.parse_or()
            if self.peek() != ")":
                raise ValueError("Missing closing parenthesis in licence expression")
            self.consume()
            return inner
        if tok in (")", "AND", "OR", "WITH"):
            raise ValueError(f"Unexpected operator token: {tok}")
        base = self.consume()
        if self.peek() == "WITH":
            self.consume()
            exc = self.peek()
            if exc is None or exc in ("(", ")", "AND", "OR", "WITH"):
                raise ValueError("Expected exception identifier after WITH")
            self.consume()
            norm_base = normalize_single_token(base)
            return _Atom(f"{norm_base} WITH {exc}")
        return _Atom(normalize_single_token(base))


def _format_expr(node: _ExprNode, parent_op: str | None = None) -> str:
    if isinstance(node, _Atom):
        return node.licence
    if isinstance(node, _And):
        text = f"{_format_expr(node.left, 'AND')} AND {_format_expr(node.right, 'AND')}"
        return f"({text})" if parent_op == "OR" else text
    if isinstance(node, _Or):
        text = f"{_format_expr(node.left, 'OR')} OR {_format_expr(node.right, 'OR')}"
        return f"({text})" if parent_op == "AND" else text
    raise TypeError(f"Unsupported AST node: {node!r}")


def normalize_expression(raw: str | None) -> str:
    """Normalize a raw metadata licence string or SPDX expression."""
    if raw is None:
        return UNKNOWN
    cleaned = " ".join(str(raw).strip().split())
    if not cleaned:
        return UNKNOWN
    if has_non_commercial_restriction(cleaned):
        return NON_COMMERCIAL
    lower = cleaned.lower()
    if lower in _CANONICAL_ALIASES:
        return _CANONICAL_ALIASES[lower]
    if is_non_commercial_id(cleaned):
        return NON_COMMERCIAL
    # Strip outer balanced parentheses if it wraps a known single alias
    if cleaned.startswith("(") and cleaned.endswith(")") and "(" not in cleaned[1:-1] and ")" not in cleaned[1:-1]:
        inner = cleaned[1:-1].strip()
        if inner.lower() in _CANONICAL_ALIASES:
            return _CANONICAL_ALIASES[inner.lower()]
    if any(op in cleaned for op in (" AND ", " OR ", " WITH ", "(", ")")):
        try:
            ast_node = _Parser(_tokenize_spdx(cleaned)).parse()
            return _format_expr(ast_node)
        except ValueError:
            return UNKNOWN
    return normalize_single_token(cleaned)


def evaluate_expression(
    expression: str,
    allowlist: set[str],
    denied: set[str],
) -> tuple[bool, list[str]]:
    """Evaluate a normalized licence expression against allowlist and denied set.

    Returns (allowed, offending_licences).
    - Under OR, the expression is allowed if at least one branch is allowed.
    - Under AND, the expression is allowed only if all branches are allowed.
    - Single atoms must appear in allowlist and not in denied.
    """
    if not expression or expression == UNKNOWN:
        return False, [UNKNOWN]
    if expression == NON_COMMERCIAL:
        return False, [NON_COMMERCIAL]

    try:
        node = _Parser(_tokenize_spdx(expression)).parse()
    except ValueError:
        return False, [UNKNOWN]

    def _eval(cur: _ExprNode) -> tuple[bool, list[str]]:
        if isinstance(cur, _Atom):
            lic = cur.licence
            # Handle "<base> WITH <exception>"
            base = lic.split(" WITH ", 1)[0] if " WITH " in lic else lic
            if lic in denied or base in denied or lic == UNKNOWN or lic == NON_COMMERCIAL:
                return False, [lic]
            if lic in allowlist or base in allowlist:
                return True, []
            return False, [lic]
        if isinstance(cur, _Or):
            ok_l, bad_l = _eval(cur.left)
            if ok_l:
                return True, []
            ok_r, bad_r = _eval(cur.right)
            if ok_r:
                return True, []
            merged = list(dict.fromkeys(bad_l + bad_r))
            return False, merged
        if isinstance(cur, _And):
            ok_l, bad_l = _eval(cur.left)
            ok_r, bad_r = _eval(cur.right)
            if ok_l and ok_r:
                return True, []
            merged = list(dict.fromkeys(bad_l + bad_r))
            return False, merged
        return False, [UNKNOWN]

    return _eval(node)
