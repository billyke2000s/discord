# Birthdays

Use `/birthday set month:September day:15 year:1966` and `/birthday show`.
Months accept English full names/three-letter abbreviations (also Sept), case
insensitively, or numbers 1–12 with optional leading zero. Days accept numbers
or correct English ordinals such as 1st, 2nd, 3rd, 15th. The year is required,
1900 or later, and the complete birth date cannot be in the future. Leap-day
validation uses the actual birth year. Invalid input leaves the saved date intact.
Day, month and birth year are stored; set/show replies are private and use only
the caller's record. The birthday announcement publicly includes the age reached
that day, with a friendly birthday wish and a mention of the birthday member.
Old saved dates are preserved with an unknown year; those members can use set
once to add their year. Their age is omitted until provided.
Dates use UTC, with a
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

