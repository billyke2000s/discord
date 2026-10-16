import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / 'scripts/release-notes.py'


def git(cwd, *args):
    return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout.strip()


class ReleaseNotesTests(unittest.TestCase):
    def test_lists_pull_request_titles_since_the_previous_release(self):
        with tempfile.TemporaryDirectory() as repo:
            git(repo, 'init', '-q', '-b', 'main')
            git(repo, 'commit', '-q', '--allow-empty', '-m', 'start')

            def merge(n, title):
                git(repo, 'checkout', '-q', '-b', f'b{n}')
                git(repo, 'commit', '-q', '--allow-empty', '-m', f'work {n}')
                git(repo, 'checkout', '-q', 'main')
                git(repo, 'merge', '-q', '--no-ff', f'b{n}', '-m', f'Merge pull request #{n} from x/b{n}\n\n{title}')

            merge(1, 'Old feature')
            previous = git(repo, 'rev-parse', 'HEAD')
            merge(2, 'Add lyrics')
            merge(3, 'Fix $(oops) "quotes"')
            git(repo, 'commit', '-q', '--allow-empty', '-m', 'direct commit, not a PR')
            run = lambda *a: json.loads(subprocess.run(['python3', str(SCRIPT), *a], cwd=repo, check=True,
                                                       capture_output=True, text=True).stdout)
            self.assertEqual(run(previous), ['Fix $(oops) "quotes"', 'Add lyrics'])
            self.assertEqual(run(), ['Fix $(oops) "quotes"', 'Add lyrics', 'Old feature'], 'no previous: recent merges')
            self.assertEqual(run('f' * 40), ['Fix $(oops) "quotes"', 'Add lyrics', 'Old feature'], 'unknown commit')


if __name__ == '__main__':
    unittest.main()
