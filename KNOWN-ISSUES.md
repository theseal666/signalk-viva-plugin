# Known issues

## No connection reuse against the VIVA endpoint (found 2026-10-19)

Observed on `KarukeraPi` with tcpdump: the plugin opens a **new TCP connection
with a full TLS handshake for every poll** against
`services.viva.sjofartsverket.se` (23.102.45.150:8080, Sjöfartsverket's service
hosted in Azure — TLS despite the 8080 port). Two fresh source ports inside one
second were seen during an idle minute.

Each handshake costs roughly 1.6 kB outbound and 5 kB inbound in pure overhead,
regardless of how little station data is actually fetched. Over a 60-second idle
window the plugin accounted for 13 kB out and 60 kB in — almost all of it setup
rather than payload.

**Fix when we next touch this plugin:** keep one agent with `keepAlive: true`
(or a persistent `undici` pool) for the lifetime of the plugin and reuse it
across polls. Worth checking the poll interval at the same time — the volume is
noticeable enough that it shows up in the gateway's per-client statistics.
