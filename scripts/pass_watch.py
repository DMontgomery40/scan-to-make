#!/usr/bin/env python3
"""Watch a design pass's worker as it works: every tool call, how long it took, and the model's thinking gaps.

Read-only. It finds the worker's own Claude Code session transcript (the companion starts each worker in its pass
folder, so the transcript is ~/.claude/projects/<the pass folder, escaped>/<session>.jsonl) and follows it. Nothing
is written, moved or started on the machine it reads.

    python3 scripts/pass_watch.py --host mac                 # the most recently active pass on David's Mac, live
    python3 scripts/pass_watch.py --host mac --project b8158144 --once   # that project's latest pass, as a timeline
    python3 scripts/pass_watch.py --file path/to/session.jsonl --once    # a copied transcript

David, Nov 16: "don't passively wait the time while it's running is the most valauble opportunity to understand
what it is doing, it might be in some ridic loop or using the wrong tools" (#859).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import queue
import shlex
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

PASS_GLOB = "~/.claude/projects/*Scan-to-Make-capture-objects-{project}*passes-pass-*/*.jsonl"
# A turn this large is the #859 pattern: a whole design planned in one thought (pass A, Nov 11: 128,000 tokens, 24 min).
BIG_TURN_TOKENS = 20_000


def _ts(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _brief(tool_input: dict) -> str:
    if "script" in tool_input:
        return f"{tool_input.get('name', '')} script={len(tool_input['script'])}ch"
    for key in ("name", "file_path", "query", "url", "script_path", "tool_name"):
        if tool_input.get(key):
            return str(tool_input[key])[:120]
    return ""


def _result_text(content) -> str:
    if isinstance(content, list):
        content = " ".join(block.get("text", f"[{block.get('type')}]") for block in content if isinstance(block, dict))
    return " ".join(str(content).split())[:140]


@dataclass
class Watch:
    """Turns transcript lines into readable lines, and keeps the totals for the summary."""
    first: dt.datetime | None = None
    last: dt.datetime | None = None
    asked_at: dt.datetime | None = None
    turns: int = 0
    output_tokens: int = 0
    largest_turn: int = 0
    big_turns: int = 0
    limit_hits: int = 0
    model_seconds: float = 0.0
    tool_seconds: dict = field(default_factory=dict)
    tool_calls: dict = field(default_factory=dict)
    pending: dict = field(default_factory=dict)
    seen: set = field(default_factory=set)

    def line(self, raw: str) -> list[str]:
        try:
            event = json.loads(raw)
        except ValueError:
            return []
        kind, stamp = event.get("type"), event.get("timestamp")
        if not stamp or kind not in ("api-request", "assistant", "user"):
            return []
        at = _ts(stamp)
        self.first = self.first or at
        self.last = at
        clock = at.strftime("%H:%M:%S")
        if kind == "api-request":
            self.asked_at = at
            return []
        message = event.get("message") or {}
        content = message.get("content")
        out: list[str] = []
        if kind == "assistant":
            if message.get("id") not in self.seen:
                self.seen.add(message.get("id"))
                self.turns += 1
                tokens = (message.get("usage") or {}).get("output_tokens") or 0
                self.output_tokens += tokens
                self.largest_turn = max(self.largest_turn, tokens)
                waited = (at - self.asked_at).total_seconds() if self.asked_at else 0.0
                self.model_seconds += waited
                flag = ""
                if tokens >= BIG_TURN_TOKENS:
                    self.big_turns += 1
                    flag = "  <<< long think"
                if message.get("stop_reason") == "max_tokens":
                    self.limit_hits += 1
                    flag += "  !!! hit max_tokens: this turn's work is lost"
                out.append(f"{clock}  model  turn {self.turns}: {waited:5.0f}s, {tokens} output tokens{flag}")
                self.asked_at = None
            for block in content if isinstance(content, list) else []:
                if block.get("type") == "tool_use":
                    name = block.get("name", "?").replace("mcp__printer__", "")
                    self.pending[block.get("id")] = (name, at)
                    self.tool_calls[name] = self.tool_calls.get(name, 0) + 1
                    out.append(f"{clock}  call   {name} {_brief(block.get('input') or {})}")
                elif block.get("type") == "text" and block.get("text", "").strip():
                    out.append(f"{clock}  says   {' '.join(block['text'].split())[:200]}")
            return out
        # A user entry: tool results, or a message Claude Code injected.
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for block in content if isinstance(content, list) else []:
            if block.get("type") == "tool_result" and block.get("tool_use_id") in self.pending:
                name, started = self.pending.pop(block["tool_use_id"])
                took = (at - started).total_seconds()
                self.tool_seconds[name] = self.tool_seconds.get(name, 0.0) + took
                error = " ERROR" if block.get("is_error") else ""
                out.append(f"{clock}  done   {name} {took:.0f}s{error}  {_result_text(block.get('content'))}")
            elif block.get("type") == "text" and "limit hit" in block.get("text", ""):
                out.append(f"{clock}  note   Claude Code: {' '.join(block['text'].split())[:120]}")
        return out

    def waiting(self, now: dt.datetime) -> str | None:
        """While the model has been asked and hasn't answered: how long it has been thinking."""
        if not self.asked_at:
            return None
        return f"{now:%H:%M:%S}  ...    thinking for {(now - self.asked_at).total_seconds():.0f}s"

    def summary(self) -> str:
        span = (self.last - self.first).total_seconds() if self.first and self.last else 0
        tools = sum(self.tool_seconds.values())
        lines = [f"span {span:.0f}s ({span / 60:.1f} min); {self.turns} model turns, {self.output_tokens} output tokens",
                 f"model time {self.model_seconds:.0f}s (to each turn's first output); tool time {tools:.0f}s (calls can overlap)",
                 f"largest turn {self.largest_turn} tokens; turns over {BIG_TURN_TOKENS}: {self.big_turns}; max_tokens hits: {self.limit_hits}"]
        for name, seconds in sorted(self.tool_seconds.items(), key=lambda item: -item[1]):
            lines.append(f"  {name}: {self.tool_calls.get(name, 0)} calls, {seconds:.0f}s")
        return "\n".join(lines)


def find_transcript(host: str | None, project: str) -> str:
    pattern = PASS_GLOB.format(project=project or "")
    command = f"ls -t {pattern} 2>/dev/null | grep -v '/\\._' | head -1"
    found = subprocess.run(["ssh", host, command] if host else ["sh", "-c", command], capture_output=True, text=True, check=False).stdout.strip()
    if not found:
        sys.exit(f"No pass transcript matches {pattern}{' on ' + host if host else ''}.")
    return found


def follow(host: str | None, path: str, once: bool):
    """The transcript's lines: all of them, then (unless once) each new one as it is written."""
    quoted = shlex.quote(path)
    command = f"cat {quoted}" if once else f"tail -n +1 -F {quoted}"
    process = subprocess.Popen(["ssh", host, command] if host else ["sh", "-c", command], stdout=subprocess.PIPE, text=True)
    try:
        yield from process.stdout
    finally:
        process.terminate()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", help="read over ssh from this host (e.g. mac); default: this machine")
    parser.add_argument("--project", default="", help="project id, or its first characters")
    parser.add_argument("--file", help="a transcript path on the host (skips the search)")
    parser.add_argument("--once", action="store_true", help="print the timeline so far and a summary, then exit")
    parser.add_argument("--heartbeat", type=float, default=30, help="seconds between 'thinking for' lines while live")
    args = parser.parse_args(argv)
    path = args.file or find_transcript(args.host, args.project)
    print(f"# {args.host + ':' if args.host else ''}{path}", flush=True)
    watch = Watch()
    if args.once:
        for raw in follow(args.host, path, True):
            for text in watch.line(raw):
                print(text)
        print("\n" + watch.summary())
        return 0
    lines: queue.Queue = queue.Queue()
    threading.Thread(target=lambda: [lines.put(raw) for raw in follow(args.host, path, False)], daemon=True).start()
    try:
        while True:
            try:
                for text in watch.line(lines.get(timeout=args.heartbeat)):
                    print(text, flush=True)
            except queue.Empty:
                note = watch.waiting(dt.datetime.now(dt.timezone.utc))
                if note:
                    print(note, flush=True)
    except KeyboardInterrupt:
        print("\n" + watch.summary())
    return 0


if __name__ == "__main__":
    sys.exit(main())
