#!/usr/bin/env python3
"""Narrow host bridge: fixed update requests, no commands/images supplied by Discord."""
import argparse
import json
import os
import re
import stat
import time
import urllib.request
from pathlib import Path
import update as updater


def read_json(path, limit=8192):
    # The request directory is writable by the bot. Never follow its symlinks.
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    with os.fdopen(fd, 'r') as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError('Not a regular file')
        data = file.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Request too large')
    return json.loads(data)


def validate_request(data, now=None):
    now = time.time() if now is None else now
    if (type(data) is not dict or set(data) != {'id', 'guildId', 'ownerId', 'createdAt'} or
            not re.fullmatch('[0-9a-f]{32}', str(data['id'])) or
            not all(re.fullmatch('[0-9]{17,20}', str(data[k])) for k in ['guildId', 'ownerId']) or
            type(data['createdAt']) not in (int, float) or
            not 0 <= now - data['createdAt'] <= 300):
        raise ValueError('Invalid or expired update request')
    return data


# Request states the worker keeps working on in later runs.
IN_PROGRESS = ('updating', 'waiting')


def write_status(path, data):
    updater.atomic_write(path, json.dumps(data), mode=0o644)  # No secrets; bot mount is read-only.


def env_settings():
    result = {}
    for line in Path('.env').read_text().splitlines():
        key, sep, value = line.partition('=')
        if sep and key in ('GUILD_ID', 'DISCORD_TOKEN'):
            if key in result:
                raise ValueError('Duplicate deployment setting')
            result[key] = value.strip().strip('\"\'')
    return result


def verify_owner(request):
    settings = env_settings()
    if request['guildId'] != settings.get('GUILD_ID'):
        raise ValueError('Request is not for the installed server')
    query = urllib.request.Request(
        f"https://discord.com/api/v10/guilds/{request['guildId']}",
        headers={'Authorization': f"Bot {settings['DISCORD_TOKEN']}", 'User-Agent': 'ServerBotUpdater/1'})
    with urllib.request.urlopen(query, timeout=15) as response:
        guild = json.loads(response.read(1_000_000))
    if guild.get('owner_id') != request['ownerId']:
        raise ValueError('Only the current Discord server owner can update')


def installed_version(state):
    env = dict(item.split('=', 1) for item in state['Config'].get('Env', []) if '=' in item)
    return env.get('BOT_BUILD_VERSION', 'unknown (older image)')


def process(directory):
    os.chdir(directory)
    status_dir = Path('updates/status')
    status_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(status_dir, 0o755)
    try:
        enabled = read_json(Path('auto-update.json')).get('enabled') is True
    except FileNotFoundError:
        enabled = False
    # 'song-gap': this worker finishes updates that wait for the gap between songs (see update.py).
    write_status(status_dir / 'heartbeat.json',
                 {'schema': 1, 'at': time.time(), 'enabled': enabled, 'features': ['song-gap']})
    if not handle_request(directory, status_dir, enabled):
        run_waiting_update(directory, enabled)


# An update waiting for a song gap that no Discord request is following (the daily timer started it):
# retry it every run until it goes in.
def run_waiting_update(directory, enabled):
    if not enabled:
        updater.clear_pending()  # turned off while waiting: let the music carry on normally
        return
    if not updater.PENDING.exists() or not updater.gap_reached():
        return
    try:
        updater.main(['--directory', str(directory), '--apply'])
    except BlockingIOError:
        pass  # another deployment holds the lock
    except Exception as error:
        print(f'Waiting update failed: {type(error).__name__}', flush=True)


# Returns True when a Discord request was handled this run (so nothing else runs).
def handle_request(directory, status_dir, enabled):
    request_path = Path('updates/requests/request.json')
    status_path = status_dir / 'result.json'
    try:
        previous = read_json(status_path)
    except FileNotFoundError:
        previous = None
    try:
        raw = read_json(request_path)
        if not isinstance(raw, dict):
            raise ValueError('Invalid request')
        if previous and raw.get('id') == previous.get('id'):
            if previous.get('state') not in IN_PROGRESS:
                return False
            request = {k: previous[k] for k in ['id', 'guildId', 'ownerId', 'createdAt']}
        else:
            request = validate_request(raw)
    except FileNotFoundError:
        # A worker killed during deployment must reconcile/report on its next run.
        if not previous or previous.get('state') not in IN_PROGRESS:
            return False
        request = {k: previous[k] for k in ['id', 'guildId', 'ownerId', 'createdAt']}
    except (ValueError, OSError):
        print('Ignoring invalid Discord update request', flush=True)
        return False
    if previous and request['id'] == previous.get('id') and previous.get('state') not in IN_PROGRESS:
        return False
    waiting = bool(previous and request['id'] == previous.get('id') and previous.get('state') == 'waiting')
    result = {**request, 'schema': 1, 'state': 'checking', 'at': time.time()}
    if not enabled:
        write_status(status_path, {**result, 'state': 'disabled'})
        return True
    if waiting and not updater.gap_reached():
        return True  # still waiting for the song to end; checked again in 15 seconds
    try:
        if not waiting:  # already verified when the request first arrived
            verify_owner(request)  # Independent host verification, not just slash visibility.
        release = updater.latest_release()
        state = updater.container_state()
        result.update(current=installed_version(state), latest=release['version'])
        if not waiting:
            write_status(status_path, {**result, 'state': 'updating'})
        outcome = updater.main(['--directory', str(directory), '--apply'])
        current = installed_version(updater.container_state())
        write_status(status_path, {**result, 'state': outcome, 'current': current, 'at': time.time()})
    except BlockingIOError:
        if not waiting:
            write_status(status_path, {**result, 'state': 'busy', 'at': time.time()})
    except Exception as error:
        # No tokens, env contents, arbitrary commands or exception strings enter Discord.
        print(f'Discord update request failed: {type(error).__name__}', flush=True)
        write_status(status_path, {**result, 'state': 'failed', 'at': time.time()})
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', default='/root/server-bot')
    args = parser.parse_args()
    directory = Path(args.directory).resolve()
    import fcntl
    # Separate worker lock; the underlying updater also takes the deployment lock.
    with open(directory / '.discord-update.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        process(directory)

