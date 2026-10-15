import importlib.util
import json
import os
import sys
import tempfile
import time
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'deployment'))
import discord_update as bridge


class DiscordUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cwd = Path.cwd()
        (self.root / 'updates/requests').mkdir(parents=True)
        (self.root / 'updates/status').mkdir(parents=True)
        (self.root / 'auto-update.json').write_text('{"enabled":true}')
        self.request = dict(id='a' * 32, guildId='12345678901234567', ownerId='22222222222222222', createdAt=time.time())

    def tearDown(self):
        os.chdir(self.cwd)
        self.temp.cleanup()

    def result(self):
        return json.loads((self.root / 'updates/status/result.json').read_text())

    def submit(self):
        (self.root / 'updates/requests/request.json').write_text(json.dumps(self.request))

    def test_request_schema_expiry_and_no_arbitrary_arguments(self):
        self.assertEqual(bridge.validate_request(self.request), self.request)
        for value in [[], {**self.request, 'command': 'bad'}, {**self.request, 'createdAt': 0}, {**self.request, 'id': '../bad'}]:
            with self.assertRaises(ValueError):
                bridge.validate_request(value)

    def test_owner_verification_failure_never_deploys(self):
        self.submit()
        with patch.object(bridge, 'verify_owner', side_effect=ValueError('private error')), patch.object(bridge.updater, 'main') as deploy:
            bridge.process(self.root)
            deploy.assert_not_called()
        self.assertEqual(self.result()['state'], 'failed')
        self.assertNotIn('private error', json.dumps(self.result()))

    def test_host_checks_current_discord_owner_without_accepting_extra_admin_ids(self):
        os.chdir(self.root)
        (self.root / '.env').write_text('GUILD_ID=12345678901234567\nDISCORD_TOKEN="private-token"\nBOT_ADMIN_IDS=33333333333333333\n')
        with patch.object(bridge.urllib.request, 'urlopen', return_value=BytesIO(b'{"owner_id":"22222222222222222"}')) as network:
            bridge.verify_owner(self.request)
            self.assertEqual(network.call_args.args[0].full_url, 'https://discord.com/api/v10/guilds/12345678901234567')
        with patch.object(bridge.urllib.request, 'urlopen', return_value=BytesIO(b'{"owner_id":"different"}')):
            with self.assertRaises(ValueError):
                bridge.verify_owner(self.request)

    def test_disabled_and_processed_requests_do_not_deploy(self):
        self.submit()
        (self.root / 'auto-update.json').write_text('{"enabled":false}')
        with patch.object(bridge.updater, 'main') as deploy:
            bridge.process(self.root)
            self.assertEqual(self.result()['state'], 'disabled')
            bridge.process(self.root)
            deploy.assert_not_called()

    def test_success_and_duplicate_are_processed_once(self):
        self.submit()
        state = {'Config': {'Env': ['BOT_BUILD_VERSION=v-new']}}
        with patch.object(bridge, 'verify_owner'), patch.object(bridge.updater, 'latest_release', return_value={'version': 'v-new'}), patch.object(bridge.updater, 'container_state', return_value=state), patch.object(bridge.updater, 'main', return_value='updated') as deploy:
            bridge.process(self.root)
            bridge.process(self.root)
            deploy.assert_called_once_with(['--directory', str(self.root), '--apply'])
        self.assertEqual(self.result()['state'], 'updated')
        self.assertEqual(self.result()['current'], 'v-new')

    def test_missing_request_reconciles_interrupted_host_status(self):
        status = {**self.request, 'state': 'updating'}
        (self.root / 'updates/status/result.json').write_text(json.dumps(status))
        with patch.object(bridge, 'verify_owner'), patch.object(bridge.updater, 'latest_release', return_value={'version': 'v-new'}), patch.object(bridge.updater, 'container_state', return_value={'Config': {'Env': []}}), patch.object(bridge.updater, 'main', return_value='current'):
            bridge.process(self.root)
        self.assertEqual(self.result()['state'], 'current')

