# Reading the bot check

Admins can use `/diagnostics` or `/diagnosis`; both commands produce the same private
report and use the same cooldown. One check can run at a time, and all admins/guilds
share one check every five minutes. A rejected request performs no resource sampling,
database checks or network test. The cooldown begins when a request is accepted,
including when it later fails. It is held in memory and resets on bot restart.

The report puts failures, warnings and missing measurements first, with a next step.
It groups the rest into server resources, internet speed, music/voice, Discord
permissions, server features, and storage/protection. A complete text attachment
keeps every result and recommendation if the compact Discord fields run out of room.
Disabled/unconfigured optional features are informational, not failed tests.

- ✅ The specific check returned an available/acceptable measurement.
- ⚠️ A measurement or recent playback observation needs review.
- ❌ The specific check failed.
- ❔ The check could not establish the result; it is not a pass.
- ➖ The feature is off, paused, or the row is informational.

No overall pass count is used to suggest that music must sound healthy.

## Resources and their limits

The CPU sample reads Linux `/proc/stat` twice over approximately one second and
shows busy percentage, time waiting for disk, and time the hypervisor withheld CPU.
The one-minute load average is shown against visible core count. Linux host memory
uses **MemAvailable**, which includes reusable cache, alongside total memory and swap
usage. These are host-visible counters; container/private namespace policies can
restrict what is visible. Missing readings are shown as unavailable.

Bot process CPU is labelled as a percentage of **one core**, with process RAM.
On cgroup v2, the bot container's current memory, memory limit and finite CPU quota
are shown separately. Older/unavailable cgroup layouts do not cause invented limits.
The music service shows its latest reported CPU and Java heap used/allocated; heap
is explicitly not the full container RAM. The bot has no Docker socket and cannot
read sibling-container limits or cipher-helper CPU/RAM, so it does not claim those
measurements. Disk free/total is measured on the mounted data filesystem.

Bot responsiveness is a short event-loop timer-delay sample. The sample occurs
before the bulk speed-test transfers, but it still represents a diagnostic run,
not a historical peak. CPU/memory warnings use 85% and 95% thresholds; waiting-time
warnings use 10%, and timer-delay warnings use 200 ms. These are operational flags,
not proof of a cause. A brief sample can miss the spike that caused a cutout.

## Bounded speed test

Every accepted check runs a small HTTPS test against the endpoints documented by
[Cloudflare's speed-test project](https://github.com/cloudflare/speedtest): three
zero-payload response-time requests, one **2 MiB** download and one **256 KiB** upload
of generated zero bytes. No bot token, playlist, database or user file is uploaded.
As with any HTTPS request, the endpoint receives the connection's source address.
The whole test has a **12-second deadline**, fixed HTTPS endpoints, no redirects,
no retries, response size caps, and cancellation of response readers. It is not the
full Cloudflare test suite and does not submit a separate results/analytics request.

Results are labelled **sampled Mbps**. Transfers are deliberately small to limit
traffic and disruption while music is playing. They include request overhead and
may understate a fast VPS's full bandwidth. Response time is HTTPS round-trip time,
not ICMP ping; reported variation is the range of three samples, not a statistically
robust jitter measurement. Below 2 Mbps or response time above 500 ms raises a review
flag. An endpoint/network error produces an unavailable result rather than zero speed
or a claim that the VPS is broken.

The test does **not** measure packet loss, loaded latency, routing to Discord's voice
server, or audible playback. A fast Cloudflare result cannot establish smooth music.
When a cutout happens, save the report and persistent music-health logs before
restarting. Compare observations at the same time rather than assuming a cause.

## Validation

Tests cover concurrent requests, cooldown expiry and failures, shared aliases and
permissions, resource parsing, report priority/size/full attachment, sample limits,
incomplete/oversized responses, cancellation, and understandable playback wording.
The bounded test completed against the real endpoint from the development computer;
that verifies endpoint integration, not the VPS's network performance.
