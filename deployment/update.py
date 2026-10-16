#!/usr/bin/env python3
"""Opt-in bot-only deployment. No downloaded scripts or Docker socket in the bot."""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = 'billyke2000s/discord'
IMAGE = re.compile(r'ghcr\.io/billyke2000s/discord@sha256:[0-9a-f]{64}')


def get_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'server-bot-updater', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        data = response.read(1_000_001)
    if len(data) > 1_000_000:
        raise ValueError('Release metadata too large')
    return json.loads(data)


def validate_manifest(data, tag):
    if (data.get('repository') != REPO or data.get('tag') != tag or
            data.get('deployment') != 1 or not IMAGE.fullmatch(data.get('image', '')) or
            not re.fullmatch('[0-9a-f]{40}', data.get('commit', ''))):
        raise ValueError('Release is not compatible with this deployment; use the manual installer')
    return data['image']


def latest_release():
    release = get_json(f'https://api.github.com/repos/{REPO}/releases/latest')
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('Refusing a draft or prerelease')
    tag = release['tag_name']
    assets = [a for a in release.get('assets', []) if a['name'] == 'update.json']
    if len(assets) != 1:
        raise ValueError('Release has no update manifest; use the manual installer')
    url = assets[0]['browser_download_url']
    if not url.startswith(f'https://github.com/{REPO}/releases/download/'):
        raise ValueError('Unexpected release asset location')
    manifest = get_json(url)
    image = validate_manifest(manifest, tag)
    return {'version': tag, 'commit': manifest['commit'], 'image': image}


def latest_image():
    return latest_release()['image']


def replace_image(text, image):
    if len(re.findall(r'^BOT_IMAGE=.*$', text, re.M)) != 1:
        raise ValueError('.env must contain exactly one BOT_IMAGE line')
    return re.sub(r'^BOT_IMAGE=.*$', f'BOT_IMAGE={image}', text, flags=re.M)


def atomic_write(path, text, mode=0o600):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.update-')
    try:
        with os.fdopen(fd, 'w') as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def run(*args):
    return subprocess.check_output(args, text=True, timeout=300).strip()


def compose(*args):
    return run('docker', 'compose', '-f', 'docker-compose.yml', *args)


def container_state():
    cid = compose('ps', '-a', '-q', 'bot')
    if not cid:
        raise ValueError('Bot container is missing')
    return json.loads(run('docker', 'inspect', cid))[0]


def wait_healthy():
    for _ in range(24):
        state = container_state()['State']
        if state.get('Health', {}).get('Status') == 'healthy':
            return
        if not state.get('Running'):
            break
        time.sleep(5)
    raise RuntimeError('Bot did not pass Discord/Lavalink readiness checks')


def deploy(image, env_path, original, recreate=None, check=None):
    recreate = recreate or (lambda: compose('up', '-d', '--no-deps', '--no-build', 'bot'))
    check = check or wait_healthy
    atomic_write(env_path, replace_image(original, image))
    try:
        recreate()
        check()
    except Exception:
        atomic_write(env_path, original)
        recreate()
        check()
        raise


def recover_pending(directory):
    journal = Path('.update-pending.json')
    if not journal.exists():
        return
    saved = json.loads(journal.read_text())
    # Restore only from the journal itself: it lives in the root-only install folder. The settings
    # copy under backups/ is for people; that folder is writable by the bot container, so it is
    # never trusted for recovery. Older journals had no 'env' and are refused.
    if (not isinstance(saved.get('env'), str) or not IMAGE.fullmatch(saved.get('image', '')) or
            len(re.findall(r'^BOT_IMAGE=.*$', saved['env'], re.M)) != 1):
        raise ValueError('Invalid recovery journal; restore .env from backups/ by hand after checking it')
    atomic_write(Path('.env'), saved['env'])
    compose('up', '-d', '--no-deps', '--no-build', 'bot')
    wait_healthy()
    atomic_write(Path('.failed-update'), saved['image'])
    journal.unlink()
    print('Recovered previous settings/image after an interrupted deployment')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default='/root/server-bot')
    parser.add_argument('--apply', action='store_true', help='Apply only if auto-update.json opts in')
    args = parser.parse_args(argv)
    directory = Path(args.directory).resolve()
    os.chdir(directory)
    if args.apply and not json.loads(Path('auto-update.json').read_text()).get('enabled') is True:
        print('Automatic updates disabled')
        return 'disabled'
    # The manual installer takes the same lock. Never run two deployments together.
    import fcntl
    with open('.deployment.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.apply:
            recover_pending(directory)
        image = latest_image()
        state = container_state()
        old = state['Config']['Image']
        if not IMAGE.fullmatch(old):
            raise ValueError('Current image must be pinned to a release digest; run the manual installer first')
        if old == image:
            print('Already on this release')
            return 'current'
        print(f'Available bot image: {image}')
        if not args.apply:
            print('Preview only; nothing changed')
            return 'preview'
        failed = Path('.failed-update')
        if failed.exists() and failed.read_text().strip() == image:
            raise ValueError('This image previously failed; inspect logs before removing .failed-update')
        if state['State'].get('Health', {}).get('Status') != 'healthy':
            raise ValueError('Current bot is not healthy; refusing an automatic deployment')
        health = json.loads(compose('exec', '-T', 'bot', 'cat', '/tmp/server-bot-health.json'))
        if health.get('sessions') != 0:
            print('Music session active; deferring to the next timer run')
            return 'deferred'
        if shutil.disk_usage(directory).free < 2 * 1024**3:
            raise ValueError('Less than 2 GiB free; clear space before updating')
        env_path = Path('.env')
        original = env_path.read_text()
        if not re.search(r'^BOT_IMAGE=["\']?' + re.escape(old) + r'["\']?\s*$', original, re.M):
            raise ValueError('Running image and .env differ; reconcile before updating')
        # Pull first: download failure cannot stop the running bot.
        run('docker', 'pull', image)
        health = json.loads(compose('exec', '-T', 'bot', 'cat', '/tmp/server-bot-health.json'))
        if health.get('sessions') != 0:
            print('Music started during download; deferring deployment')
            return 'deferred'
        os.umask(0o077)
        backup = Path('backups') / ('auto-update-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S'))
        backup.mkdir(mode=0o700)
        shutil.copy2(env_path, backup / '.env')
        shutil.copy2('docker-compose.yml', backup / 'docker-compose.yml')
        if Path('locks').exists():
            shutil.copytree('locks', backup / 'locks')
        # SQLite's online backup API makes a consistent snapshot while the bot runs.
        compose('exec', '-T', 'bot', 'node', 'src/lib/backup.js', 'pre-update')
        journal = Path('.update-pending.json')
        # 0600, root-only folder: holds the settings to restore if this run is interrupted.
        atomic_write(journal, json.dumps({'backup': str(backup / '.env'), 'image': image, 'env': original}))
        try:
            deploy(image, env_path, original)
        except Exception:
            atomic_write(failed, image)
            raise
        journal.unlink()
        print(f'Deployed and healthy. Settings backup: {backup}; SQLite backup in backups/')
        return 'updated'


if __name__ == '__main__':
    main()

