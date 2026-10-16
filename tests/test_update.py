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

    def test_recovery_refuses_journal_without_saved_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / 'backups' / 'saved').mkdir(parents=True)
            (directory / 'backups' / 'saved' / '.env').write_text('BOT_IMAGE=evil\n')
            (directory / '.env').write_text('BOT_IMAGE=new\n')
            (directory / '.update-pending.json').write_text(update.json.dumps({'backup': 'backups/saved/.env', 'image': IMAGE}))
            previous = Path.cwd()
            try:
                update.os.chdir(directory)
                with patch.object(update, 'compose') as compose, patch.object(update, 'wait_healthy'):
                    with self.assertRaises(ValueError):
                        update.recover_pending(directory)
                    compose.assert_not_called()
                self.assertEqual((directory / '.env').read_text(), 'BOT_IMAGE=new\n')
            finally:
                update.os.chdir(previous)

    def test_interrupted_deployment_recovers_previous_image(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            (directory / 'backups' / 'saved').mkdir(parents=True)
            (directory / 'backups' / 'saved' / '.env').write_text('BOT_IMAGE=old\n')
            (directory / '.env').write_text('BOT_IMAGE=new\n')
            # A tampered copy in the bot-writable backups folder must be ignored.
            (directory / 'backups' / 'saved' / '.env').write_text('BOT_IMAGE=evil\n')
            (directory / '.update-pending.json').write_text(
                update.json.dumps({'backup': 'backups/saved/.env', 'image': IMAGE, 'env': 'BOT_IMAGE=old\n'}))
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


class SongGapTests(unittest.TestCase):
    """While music plays, an update waits for the gap between songs (at most WAIT_MAX)."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        update.os.chdir(self.temp.name)
        self.release = {'image': IMAGE, 'version': 'v-new', 'commit': 'c' * 40}

    def tearDown(self):
        update.os.chdir(self.previous)
        self.temp.cleanup()

    def test_no_music_goes_ahead_without_marking_anything(self):
        self.assertTrue(update.music_gap({'sessions': 0}, self.release, now=100))
        self.assertFalse(update.PENDING.exists())

    def test_music_marks_the_update_as_waiting_until_the_gap_or_the_time_limit(self):
        self.assertFalse(update.music_gap({'sessions': 1}, self.release, now=100))
        pending = update.read_pending()
        self.assertEqual((pending['image'], pending['version'], pending['since']), (IMAGE, 'v-new', 100))
        self.assertEqual(update.PENDING.stat().st_mode & 0o777, 0o644, 'the bot must be able to read it')
        self.assertFalse(update.music_gap({'sessions': 1}, self.release, now=100 + update.WAIT_MAX - 1))
        self.assertEqual(update.read_pending()['since'], 100, 'waiting does not restart the clock')
        self.assertTrue(update.music_gap({'sessions': 1}, self.release, now=100 + update.WAIT_MAX))
        newer = {**self.release, 'image': IMAGE[:-1] + 'b', 'version': 'v-newer'}
        self.assertFalse(update.music_gap({'sessions': 1}, newer, now=100 + update.WAIT_MAX))
        self.assertEqual(update.read_pending()['version'], 'v-newer')

    def test_gap_check_is_local_and_cheap(self):
        self.assertTrue(update.gap_reached(now=100), 'nothing waiting')
        update.music_gap({'sessions': 1}, self.release, now=100)
        with patch.object(update, 'compose', return_value='{"sessions": 1}') as compose:
            self.assertFalse(update.gap_reached(now=200))
        with patch.object(update, 'compose', return_value='{"sessions": 0}'):
            self.assertTrue(update.gap_reached(now=200))
        with patch.object(update, 'compose') as compose:
            self.assertTrue(update.gap_reached(now=100 + update.WAIT_MAX))
            compose.assert_not_called()

    def test_waiting_apply_stops_before_any_change_and_errors_clear_the_wait(self):
        state = {'Config': {'Image': IMAGE[:-1] + 'f'}}
        with patch.object(update, 'compose', return_value='{"sessions": 2}'), patch.object(update, 'run') as run:
            self.assertEqual(update.apply(Path(self.temp.name), self.release, state, Path('.failed-update')), 'waiting')
            run.assert_not_called()
        self.assertTrue(update.PENDING.exists())
        update.clear_pending()
        self.assertFalse(update.PENDING.exists())
        update.clear_pending()  # clearing twice is fine


class SongGapDeployTests(unittest.TestCase):
    def test_waiting_marker_stays_through_the_deployment_and_is_cleared_after(self):
        with tempfile.TemporaryDirectory() as folder:
            previous = Path.cwd()
            update.os.chdir(folder)
            try:
                Path('.env').write_text('BOT_IMAGE=' + IMAGE[:-1] + 'f\n')
                Path('docker-compose.yml').write_text('services: {}\n')
                Path('backups').mkdir()
                release = {'image': IMAGE, 'version': 'v-new'}
                update.music_gap({'sessions': 1}, release, now=1)  # waited since t=1, long ago
                seen = []
                with patch.object(update, 'compose', return_value='{"sessions": 0}'), patch.object(update, 'run'), \
                        patch.object(update, 'deploy', side_effect=lambda *a: seen.append(update.PENDING.exists())):
                    state = {'Config': {'Image': IMAGE[:-1] + 'f'}}
                    self.assertEqual(update.apply(Path(folder), release, state, Path('.failed-update')), 'updated')
                self.assertEqual(seen, [True], 'still marked while the new bot starts')
                self.assertFalse(update.PENDING.exists(), 'cleared once installed')
            finally:
                update.os.chdir(previous)
