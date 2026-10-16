#!/usr/bin/env python3
"""Print, as one line of JSON, the titles of the pull requests merged since the previous release.

Usage: release-notes.py [PREVIOUS_RELEASE_COMMIT]
GitHub's merge commits read "Merge pull request #N from ..." with the PR title as the body's first line.
Without a usable previous commit (first release, or history rewritten), the last five merges are used.
Shown to members when music resumes after an update, so only titles go in: no authors, links or bodies.
"""
import json
import re
import subprocess
import sys

MAX_NOTES = 8


def git(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True, check=False)


def titles(previous):
    if previous and re.fullmatch('[0-9a-f]{40}', previous) and git('merge-base', '--is-ancestor', previous, 'HEAD').returncode == 0:
        span = [f'{previous}..HEAD']
    else:
        span = ['-5', 'HEAD']
    out = git('log', '--merges', '--format=%s%x1f%b%x1e', *span).stdout
    notes = []
    for entry in out.split('\x1e'):
        subject, _, body = entry.strip().partition('\x1f')
        if not subject.startswith('Merge pull request'):
            continue
        title = next((line.strip() for line in body.splitlines() if line.strip()), '')
        if title and title not in notes:
            notes.append(title[:150])
    return notes[:MAX_NOTES]


if __name__ == '__main__':
    print(json.dumps(titles(sys.argv[1] if len(sys.argv) > 1 else '')))
