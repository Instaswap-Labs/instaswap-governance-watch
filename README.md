# InstaSwap governance watch

Public, read-only watcher of the governance of the InstaSwap walletless escrow factories (28 factories on 13 EVM
chains today, the next generation added when it is deployed). Every 5 minutes a GitHub Action reads the on-chain
getters of every factory (owner, pending owner, operator, pending operator, guardian, pending guardian, approver
set, threshold, floor, approver epoch, pending approver set, treasury, pause, refund timeout, creation unlock),
writes [`state/governance.json`](state/governance.json) and posts every change to the public channel with its
countdown. Nothing here holds a key; the only secrets are the channel credentials and one RPC URL.

- Page: https://instaswap.com/security/governance (renders `state/governance.json` and `state/events.json`)
- Channel: the `#governance` channel of the InstaSwap Discord (posts changes only; silence means nothing moved)
- Contracts and audit material: https://github.com/Instaswap-Labs/instaswap-escrow-audit
- Factory records: [`records/`](records/) (copies of the deployment records of the audit repository)

What a message means: `SCHEDULED <kind> ... effective <time> (in 47 h 59 min)` is a change the factory owner
announced on chain; it cannot execute before that time, can be cancelled meanwhile by the owner or the guardian,
and lapses if nobody executes it within 7 days after. `OWNER / OPERATOR / GUARDIAN / APPROVER SET CHANGED` is a
change that executed. `PAUSED` is the guardian or owner brake (fund moves stop, customer refunds do not).

Run it yourself: `npm ci && node watcher.mjs --once` (state under `./state`); `FACTORY_RECORDS=a.json,b.json`
to point at other records; `<CHAIN>_RPC_URL` to use your own RPCs (Arc has no public RPC).
