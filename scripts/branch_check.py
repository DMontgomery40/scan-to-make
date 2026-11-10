#!/usr/bin/env python3
"""Who is writing what, and does it still agree with main?  (David, 2026-11-01: "make sure ... no one
is writing on top of each other and in worktrees that have already been changed by a sibling session
next door and all of sudden nothing agrees.")

  python3 scripts/branch_check.py                 # report every live branch against main
  python3 scripts/branch_check.py --merge KAN-x   # gate before merging KAN-x; exit 1 if it isn't safe

Uses git's real three-way merge (git merge-tree), so squash-merged work counts as merged and only
true conflicts count. For each live remote branch it reports: commits behind main, files it would
still change on main, files that conflict with main. The --merge gate fails when the branch:
  - is behind main (rebase, re-run stm-ci / ci_local.py at the new head, push, then merge),
  - conflicts with main, or
  - conflicts with another branch active in the last --active-hours, merged in either order
    (agree the order; the later one rebases on the earlier).
Files shared without a conflict are listed as warnings: merge, then re-test the later branch.
A branch named train/<date> may carry other live branches whole (docs/operations.md): they are listed, not
blockers, and its boundary check covers every chunk they bring.
Read-only: it fetches, never pushes, merges or deletes.
"""
import argparse
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))


def git(*args, check=True):
    done = subprocess.run(['git', *args], text=True, capture_output=True)
    if check and done.returncode not in (0, 1):
        raise RuntimeError('git ' + ' '.join(args) + ': ' + done.stderr.strip())
    return done


def merge(a, b):
    """(tree, conflicted files) for merging b into a, without touching any checkout."""
    done = git('merge-tree', '--write-tree', '--name-only', '--no-messages', a, b)
    lines = done.stdout.strip().splitlines()
    return lines[0], (lines[1:] if done.returncode == 1 else [])


def is_ancestor(a, b):
    return subprocess.run(['git', 'merge-base', '--is-ancestor', a, b]).returncode == 0


def commit_of(tree, parent):
    return git('commit-tree', tree, '-p', parent, '-m', 'branch_check scratch').stdout.strip()


def live_branches(main):
    refs = git('for-each-ref', '--format=%(refname:short) %(committerdate:unix)', 'refs/remotes/origin').stdout.splitlines()
    main_tree = git('rev-parse', main + '^{tree}').stdout.strip()
    out = {}
    for line in refs:
        ref, stamp = line.rsplit(' ', 1)
        if ref in ('origin', 'origin/HEAD', main):
            continue
        tree, conflicts = merge(main, ref)
        changes = set(filter(None, git('diff', '--name-only', main_tree, tree).stdout.splitlines())) | set(conflicts)
        if not changes:
            continue  # nothing main lacks: merged (including squash-merged) or empty
        out[ref.removeprefix('origin/')] = {
            'ref': ref, 'behind': int(git('rev-list', '--count', ref + '..' + main).stdout.strip()),
            'changes': changes, 'conflicts': conflicts, 'age_h': (time.time() - int(stamp)) / 3600}
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--merge', metavar='BRANCH', help='gate this branch for merging')
    ap.add_argument('--main', default='origin/main')
    ap.add_argument('--active-hours', type=float, default=6.0, help='older branches are reported as stale, not blockers')
    ap.add_argument('--no-fetch', action='store_true')
    ap.add_argument('--boundary-reviewed', metavar='WHY', help='merge although the boundary check flagged or could not check the diff; printed in the gate output')
    ap.add_argument('--lands-first', metavar='WHY', help='this branch lands before the active branches it conflicts with, and their owners know they rebase on it; printed in the gate output')
    a = ap.parse_args()
    if not a.no_fetch:
        subprocess.run(['git', 'fetch', '-q', '--prune', 'origin'], check=True)
    branches = live_branches(a.main)
    active = {n for n, b in branches.items() if b['age_h'] <= a.active_hours}

    print(f'{"branch":40} {"behind":>6} {"changes":>7} {"conflicts":>9} {"age":>6}  state')
    for name, b in sorted(branches.items(), key=lambda kv: kv[1]['age_h']):
        if b['conflicts']: state = 'conflicts with main'
        elif name not in active: state = 'stale: close or rebase'
        elif b['behind']: state = 'needs rebase'
        else: state = 'current'
        print(f'{name:40} {b["behind"]:>6} {len(b["changes"]):>7} {len(b["conflicts"]):>9} {b["age_h"]:>5.1f}h  {state}')

    if not a.merge:
        return 0
    name = a.merge.removeprefix('origin/')
    if name not in branches:
        print(f'\n{name}: nothing to merge (main already has all of it, or no such remote branch).')
        return 1
    b = branches[name]
    problems, warnings = [], []
    # A train (docs/operations.md, "Changing code: one trunk") lands the finished branches it carries, together.
    train, carried = name.startswith('train/'), []
    if b['behind']:
        problems.append(f'{b["behind"]} commits behind main: rebase, re-run stm-ci / ci_local.py at the new head, push, then merge.')
    if b['conflicts']:
        problems.append('conflicts with main in: ' + ', '.join(b['conflicts']))
    for other in sorted(active - {name}):
        o = branches[other]
        # Stacked branches land in ancestor order, so the reverse order is impossible and not a conflict.
        if is_ancestor(o['ref'], b['ref']):
            if train:
                carried.append(other)
                continue
            problems.append(f'stacked on {other}: merge {other} first (merging this one now would land {other}\'s unmerged commits too).')
            continue
        if is_ancestor(b['ref'], o['ref']):
            warnings.append(f'{other} is stacked on this branch: it lands after it.')
            continue
        shared = sorted(b['changes'] & o['changes'])
        if not shared or o['conflicts']:
            continue  # nothing in common, or the other branch can't land as-is (its own row says so)
        clashes = set()
        for first, second in ((o['ref'], b['ref']), (b['ref'], o['ref'])):
            tree, conflicts = merge(a.main, first)
            if conflicts: continue  # that branch can't land as-is anyway; reported on its own line
            clashes |= set(merge(commit_of(tree, git('rev-parse', a.main).stdout.strip()), second)[1])
        if clashes and a.lands_first:
            warnings.append(f'conflicts with {other} in {", ".join(sorted(clashes))}: this branch lands first ({a.lands_first}); {other} rebases on it.')
        elif clashes:
            problems.append(f'conflicts with {other} in {", ".join(sorted(clashes))}: agree the order; the later one rebases on the earlier '
                            '(the one that lands first passes --lands-first "<who agreed, and that the other rebases>").')
        else:
            warnings.append(f'shares {", ".join(shared)} with {other} (merges cleanly): re-test whichever lands second.')
    # PRD §8.0: printer/slicer/firmware/Blender/Fusion knowledge belongs in the MCPs, not app code.
    import boundary_check
    if carried:
        warnings.append(f'carries {", ".join(carried)}: they land with this train.')
        # Each carried branch could bring a full boundary budget of its own; a train checks all of it at once.
        boundary_check.MAX_CHUNKS *= len(carried)
    if boundary_check.check(a.main, b['ref']) != 0:
        if a.boundary_reviewed:
            warnings.append(f'boundary check not clean; merging as reviewed: {a.boundary_reviewed}')
        else:
            problems.append('the boundary check flagged this diff or could not run (above): move that code to the MCPs (PRD §8.0), '
                            'or pass --boundary-reviewed "<why it belongs in the app>".')
    print()
    for w in warnings:
        print('warning: ' + w)
    if problems:
        print(f'NOT SAFE to merge {name}:')
        for p in problems:
            print('  - ' + p)
        return 1
    print(f'SAFE to merge {name}: current with main, no conflict with main or with another active branch.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
