# token-launch-radar-v3

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ansunchiang/token-launch-radar-v3/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ansunchiang/token-launch-radar-v3/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Forward Window** ranks protocols from the sealed DefiLlama snapshot by modeled cap if launched, multiplied by conditional 24-month own-token odds. Independent priced token families support the cap fit. Leave-one-out and expanding listing-cohort checks evaluate features, and nested held-out residuals measure cap interval coverage. The snapshot records current status, so the dashboard labels future launch odds and joint value bands as scenarios.

Every ranked record includes a timed farm plan with a TVL-scaled ticket, route fees, capital carry, exit rules and break-even calculations. The offline dashboard recomputes the board and its checksum with the same model as the CLI.

With Node.js 22.18 or later and the kit next to this repository, run:

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

Open `out/dashboard/index.html` in a browser. The build also writes `out/board.json` and `out/dossier.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vxfctj3d&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
