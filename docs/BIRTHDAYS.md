# Birthdays

Use `/birthday set month:10 day:15`, `/birthday show`.
Only the day and month are stored; replies are private. Dates use UTC, with a
check on startup and every minute. February 29 birthdays run on February 29 only.
No catch-up announcement is sent for dates spent entirely offline.

The bot posts in the saved birthday channel. Older installations automatically
reuse a unique channel named `🎂・birthdays`; rebuild saves the new channel ID.
It creates a zero-permission, hoisted `👑 Birthday` role and assigns it for 24 hours
from the first celebration attempt. Manage Roles and sufficient role hierarchy
are required. An existing saved role with permissions is refused.

Dates in the historical `birthdays` table are retained. Role expiry is saved
separately, survives restarts/date removal, and retries failed removals each minute.
If the bot is offline at expiry, removal happens after it comes back online.
Changing a date does not enable another announcement in the same calendar year.
Announcement attempts are recorded before sending to avoid repeated birthday pings
after a crash; a failed send is logged and is not automatically retried that year.
All tables are additive and compatible with rollback to the preceding bot image.

