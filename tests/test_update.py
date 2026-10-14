import importlib.util
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('update', Path(__file__).parents[1] / 'deployment/update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)
IMAGE = 'ghcr.io/billyke2000s/discord@sha256:' + 'a' * 64


class UpdateTests(unittest.TestCase):
    def test_manifest(self):
        data = dict(repository=update.REPO, tag='v1', deployment=1, image=IMAGE, commit='b' * 40)
        self.assertEqual(update.validate_manifest(data, 'v1'), IMAGE)
        for key, value in [('image', 'ghcr.io/evil/bot:latest'), ('deployment', 2), ('tag', 'v2'), ('commit', 'main')]:
            with self.assertRaises(ValueError):
                update.validate_manifest({**data, key: value}, 'v1')

    def test_settings_preserved(self):
        before = 'DISCORD_TOKEN=secret\nBOT_IMAGE=old\nALLOW_REBUILD=no\n'
        after = update.replace_image(before, IMAGE)
        self.assertIn('DISCORD_TOKEN=secret\n', after)
        self.assertIn('ALLOW_REBUILD=no\n', after)
        with self.assertRaises(ValueError):
            update.replace_image('BOT_IMAGE=a\nBOT_IMAGE=b\n', IMAGE)

    def test_rolls_back_after_health_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / '.env'
            original = 'BOT_IMAGE=old\nTOKEN=keep\n'
            env.write_text(original)
            seen = []

            def recreate():
                seen.append(env.read_text())

            checks = iter([False, True])

            def check():
                if not next(checks):
                    raise RuntimeError('unhealthy')

            with self.assertRaisesRegex(RuntimeError, 'unhealthy'):
                update.deploy(IMAGE, env, original, recreate, check)
            self.assertEqual(env.read_text(), original)
            self.assertEqual(len(seen), 2)
            self.assertIn(IMAGE, seen[0])
            self.assertEqual(seen[1], original)

    def test_successful_deployment(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / '.env'
            update.deploy(IMAGE, env, 'BOT_IMAGE=old\n', lambda: None, lambda: None)
            self.assertEqual(env.read_text(), 'BOT_IMAGE=' + IMAGE + '\n')

    def test_interrupted_deployment_recovers_previous_image(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / 'backups' / 'saved').mkdir(parents=True)
            (directory / 'backups' / 'saved' / '.env').write_text('BOT_IMAGE=old\n')
            (directory / '.env').write_text('BOT_IMAGE=new\n')
            (directory / '.update-pending.json').write_text(update.json.dumps({'backup': 'backups/saved/.env', 'image': IMAGE}))
            previous = Path.cwd()
            try:
                update.os.chdir(directory)
                with patch.object(update, 'compose'), patch.object(update, 'wait_healthy'):
                    update.recover_pending(directory)
                self.assertEqual((directory / '.env').read_text(), 'BOT_IMAGE=old\n')
                self.assertFalse((directory / '.update-pending.json').exists())
                self.assertEqual((directory / '.failed-update').read_text(), IMAGE)
            finally:
                update.os.chdir(previous)
