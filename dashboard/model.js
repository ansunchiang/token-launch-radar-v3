(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RadarModel = api;
})(globalThis, function () {
  'use strict';

  const DAY = 86400000;
  const BOOTS = 128;
  const LIMITS = [0.10, 0.25, 0.50, 0.75, 0.90];
  const CAP_TERMS = ['Log TVL', 'Category', 'Chain count', 'Years listed', '7d carry'];
  const ODDS_TERMS = ['Category', 'Log TVL', '7d carry'];
  const DEFAULTS = Object.freeze({ deposit: 0, drop: 0.08, days: 84 });
  const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
  const sum = values => values.reduce((a, b) => a + b, 0);
  const mean = a => a.length ? sum(a) / a.length : 0;
  const byText = (a, b) => a < b ? -1 : Number(a > b);
  const ascending = a => [...a].sort((x, y) => x - y);
  function quantile(sorted, t) {
    const i = (sorted.length - 1) * t;
    const low = sorted[Math.floor(i)] ?? 0;
    return low + ((sorted[Math.ceil(i)] ?? low) - low) * (i % 1);
  }
  const sd = a => {
    const mid = mean(a);
    return Math.sqrt(sum(a.map(x => (x - mid) ** 2)) / Math.max(1, a.length - 1));
  };
  const median = a => quantile(ascending(a), 0.5);
  const date = s => s ? Date.parse(s + 'T00:00:00Z') / DAY : NaN;
  const money = n => '$' + Math.round(n).toLocaleString('en-US');
  const tokenRecorded = p => Boolean(p.gecko_id || p.symbol || p.mcap_usd > 0);
  const stableReceipt = p => /^(Stablecoin Wrapper|Dual-Token Stablecoin|Stablecoin Issuer|Algo-Stables|Reserve Currency)$/.test(p.category);
  const structural = p => /^(Bridge|Canonical Bridge|Cross Chain Bridge|Liquid Staking|Liquid Restaking|Restaked BTC|CEX|Anchor BTC|Decentralized BTC)$/.test(p.category)
    || /\b(wrapped|staked|staking)\b|\s(?:v\d+(?:\.\d+)*|\d+\.\d+)$/i.test(p.name);
  const usableCap = p => p.mcap_usd > 0 && p.mcap_usd / p.tvl_usd >= 0.0001 && p.mcap_usd / p.tvl_usd <= 1000;
  const titleRoot = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  function ledgerOf(snapshot) {
    const buckets = { Watchlist: [], 'Off-list': [], Early: [], Priced: [], Unpriced: [], Excluded: [] };
    const watch = new Set(snapshot.watchlist);
    const roots = snapshot.protocols.map(p => [titleRoot(p.name), p]);
    const exchanges = roots.filter(([, p]) => p.category === 'CEX').map(([name]) => name + ' ');
    const now = date(snapshot.as_of);
    for (const p of snapshot.protocols) {
      const title = titleRoot(p.name);
      const listed = date(p.listed_at);
      const age = Number.isFinite(listed) ? Math.max(0.02, (now - listed) / 365.25) : null;
      const recorded = tokenRecorded(p);
      const excluded = structural(p) || exchanges.some(prefix => title.startsWith(prefix)) || p.category === 'Stablecoin Wrapper';
      const bucket = watch.has(p.slug) ? 'Watchlist' : excluded ? 'Excluded' :
        recorded ? (usableCap(p) && !stableReceipt(p) ? 'Priced' : 'Unpriced') :
        p.tvl_usd >= snapshot.floor_usd ? 'Off-list' : 'Early';
      const parent = bucket === 'Off-list' && roots.find(([root, q]) =>
        root.length > 3 && (title.startsWith(root + ' ') || p.slug.startsWith(q.slug + '-')))?.[1];
      const linked = bucket === 'Off-list' && Boolean(parent || /\b(curator|international|asset management|core|yield layer|vaults?)$/i.test(p.name));
      const own = linked ? 0.30 : bucket === 'Off-list' ? 0.60 : stableReceipt(p) ? 0.35 : 1;
      const parentShare = parent ? Math.max(0.20, p.tvl_usd / (p.tvl_usd + parent.tvl_usd)) : linked ? 0.65 : 1;
      buckets[bucket].push({
        ...p, category: p.category || 'Unclassified', listed, age, bucket, recorded, excluded, linked, own, parentShare
      });
    }
    return buckets;
  }

  function independentTokens(rows) {
    const roots = rows.map((_, i) => i);
    const find = i => roots[i] === i ? i : (roots[i] = find(roots[i]));
    const seen = new Map();
    rows.forEach((r, i) => {
      for (const key of [r.gecko_id && 'id:' + r.gecko_id.toLowerCase(), r.symbol && 'sym:' + r.symbol.toLowerCase()]) {
        if (!key) continue;
        if (seen.has(key)) roots[find(i)] = find(seen.get(key));
        else seen.set(key, i);
      }
    });
    const leads = new Map();
    rows.forEach((p, i) => {
      const family = find(i);
      if (!leads.has(family) || leads.get(family).tvl_usd < p.tvl_usd) leads.set(family, p);
    });
    return [...leads.values()];
  }

  function randomFrom(seed) {
    return () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 4294967296;
    };
  }

  function prepare(p, context, eligibleTvl = p.tvl_usd) {
    const age = p.age ?? context.typicalAge;
    const storage = Math.log(eligibleTvl / 5e7);
    const carry = p.change_7d === null ? 0 : clamp((p.change_7d - context.marketCarry) / 20, -3, 3);
    return {
      ...p, storage, carry, modelAge: age,
      x: [storage, 0, Math.log1p(p.chains.length) - Math.log(2), Math.log1p(age) - Math.log(2), carry, 0]
    };
  }

  // Huber ridge on log(cap / TVL).
  function capFit(rows, terms) {
    const effects = new Map();
    const beta = Array(6).fill(0);
    if (!rows.length) return { intercept: -2, beta, effects };
    const residual = rows.map(p => clamp(p.y, -9, 4));
    let intercept = median(residual);
    for (let i = 0; i < residual.length; i++) residual[i] -= intercept;
    const groups = terms.includes(1) ? Object.entries(Object.groupBy(rows.keys(), i => rows[i].category)) : [];
    for (let pass = 0; pass < (terms.length ? 10 : 2); pass++) {
      const weights = residual.map(r => Math.min(1, 1.45 / (Math.abs(r) || 1)));
      const shift = sum(residual.map((r, i) => r * weights[i])) / sum(weights);
      intercept += shift;
      for (let i = 0; i < residual.length; i++) residual[i] -= shift;
      for (const j of terms) {
        if (j === 1) {
          for (const [category, indexes] of groups) {
            const prior = effects.get(category) || 0;
            const change = (sum(indexes.map(i => weights[i] * residual[i])) - 7 * prior) /
              (sum(indexes.map(i => weights[i])) + 7);
            effects.set(category, prior + change);
            for (const i of indexes) residual[i] -= change;
          }
        } else {
          let numerator = -4 * beta[j];
          let denominator = 4;
          for (let i = 0; i < rows.length; i++) {
            const x = rows[i].x[j];
            numerator += weights[i] * x * residual[i];
            denominator += weights[i] * x * x;
          }
          const change = numerator / denominator;
          beta[j] += change;
          for (let i = 0; i < rows.length; i++) residual[i] -= change * rows[i].x[j];
        }
      }
    }
    return { intercept, beta, effects };
  }

  function capLog(fit, p) {
    return Math.log(5e7) + p.storage + fit.intercept + (fit.effects.get(p.category) || 0)
      + fit.beta.reduce((acc, b, i) => i === 1 ? acc : acc + b * p.x[i], 0);
  }

  function expanding(rows) {
    const dates = rows.filter(p => Number.isFinite(p.listed)).sort((a, b) => a.listed - b.listed || byText(a.slug, b.slug));
    const starts = [...new Set([0.40, 0.52, 0.64, 0.76, 0.88].map(q => dates[Math.floor(dates.length * q)]?.listed))];
    return starts.map((start, i) => ({
      train: dates.filter(r => r.listed < start),
      test: dates.filter(r => r.listed >= start && r.listed < (starts[i + 1] ?? Infinity))
    })).filter(x => x.train.length >= 12 && x.test.length);
  }

  const folds = (rows, n) => Array.from({ length: n }, (_, k) => ({
    train: rows.filter((_, i) => i % n !== k),
    test: rows.filter((_, i) => i % n === k)
  })).filter(x => x.test.length);
  const leaveOneOut = rows => folds(rows, rows.length);
  function capErrors(splits, terms) {
    return splits.flatMap(({train, test}) => {
      const fit = capFit(train, terms);
      return test.map(p => Math.log(p.mcap_usd) - capLog(fit, p));
    });
  }
  const capStats = errors => ({
    miss: Math.exp(median(errors.map(Math.abs))),
    within: mean(errors.map(e => Number(Math.abs(e) <= Math.log(3)))),
    n: errors.length
  });

  function selectTerms(names, stats, loss, baseline) {
    const terms = [];
    let best = stats(terms);
    const evidence = [{ name: baseline, kept: true, scores: best }];
    for (const [j, name] of names.entries()) {
      const scores = stats([...terms, j]);
      const kept = scores.every((score, i) => score.n && score[loss] < best[i][loss] - 0.00001);
      if (kept) {
        terms.push(j);
        best = scores;
      }
      evidence.push({ name, kept, scores });
    }
    return { terms, evidence, best };
  }

  const capSelection = (loo, forward) => selectTerms(CAP_TERMS,
    terms => [loo, forward].map(s => capStats(capErrors(s, terms))), 'miss', 'Flat multiple');

  // Nested interval audit.
  function intervalAudit(splits, forward) {
    const counts = [0, 0];
    let n = 0;
    for (const { train, test } of splits) {
      const innerTime = expanding(train);
      const recipe = capSelection(folds(train, 4), innerTime).terms;
      const errors = ascending(capErrors(forward && innerTime.length ? innerTime : folds(train, 5), recipe));
      const fit = capFit(train, recipe);
      for (const p of test) {
        const error = Math.log(p.mcap_usd) - capLog(fit, p);
        [0.25, 0.10].forEach((alpha, i) => {
          const last = errors.length - 1;
          const low = Math.max(0, Math.floor((errors.length + 1) * alpha) - 1);
          const high = Math.min(last, Math.ceil((errors.length + 1) * (1 - alpha)) - 1);
          counts[i] += Number(error >= errors[low] && error <= errors[high]);
        });
        n++;
      }
    }
    return { n, hits: counts.map(k => k / Math.max(n, 1)) };
  }

  // The 0.78 shape imposes declining hazard. The 2.6-year scale is a scenario prior.
  const curve = (years, scale) => -Math.expm1(-Math.pow(years / scale, 0.78));
  const logistic = x => 1 / (1 + Math.exp(-x));
  function oddsFit(rows, terms, scale = 2.6) {
    const effects = new Map();
    const beta = [0, 0, 0];
    const exposures = rows.map(p => curve(p.modelAge, scale));
    let intercept = 0;
    if (!rows.length) return { intercept, effects, beta, scale };
    const [category, size, carry] = [0, 1, 2].map(term => terms.includes(term));
    for (let pass = 0; pass < 36; pass++) {
      let grad = 0;
      const bg = [0, 0, 0];
      const cg = new Map();
      const cn = new Map();
      for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        const eta = intercept + (effects.get(p.category) || 0) + beta[1] * p.storage + beta[2] * p.carry;
        const a = logistic(eta);
        const prob = a * exposures[i];
        const score = (p.recorded ? 1 : -prob / (1 - prob)) * (1 - a);
        grad += score;
        if (category) {
          cg.set(p.category, (cg.get(p.category) || 0) + score);
          cn.set(p.category, (cn.get(p.category) || 0) + 1);
        }
        if (size) bg[1] += score * p.storage;
        if (carry) bg[2] += score * p.carry;
      }
      intercept = clamp(intercept + grad / rows.length * 3, -5, 4);
      for (const [key, g] of cg) {
        const b = effects.get(key) || 0;
        effects.set(key, b + 3 * (g - 5 * b) / (cn.get(key) + 22));
      }
      beta[1] += (bg[1] - 7 * beta[1]) / rows.length;
      beta[2] += (bg[2] - 7 * beta[2]) / rows.length;
    }
    return { intercept, effects, beta, scale };
  }

  function tokenOdds(p, fit) {
    if (p.recorded) return { now: 1, later: 1, forward: 0, own: 0 };
    const a = logistic(fit.intercept + (fit.effects.get(p.category) || 0) + fit.beta[1] * p.storage + fit.beta[2] * p.carry);
    const now = a * curve(p.modelAge, fit.scale);
    const later = a * curve(p.modelAge + 2, fit.scale);
    const forward = (later - now) / (1 - now);
    return { now, later, forward, own: forward * p.own };
  }

  function oddsErrors(splits, terms, base = false) {
    const pairs = splits.flatMap(({ train, test }) => {
      const fit = base ? null : oddsFit(train, terms);
      const prior = (train.filter(p => p.recorded).length + 1) / (train.length + 2);
      return test.map(p => {
        const prediction = fit ? tokenOdds({ ...p, recorded: false }, fit).now : prior;
        return [prediction, Number(p.recorded)];
      });
    });
    return { brier: mean(pairs.map(([p, y]) => (p - y) ** 2)), n: pairs.length };
  }

  function fitModel(ledger) {
    const rows = Object.values(ledger).flat();
    const independent = rows.filter(p => !p.excluded && !stableReceipt(p));
    const typicalAge = median(independent.filter(p => !p.recorded && p.age !== null).map(p => p.age)) || 1;
    const marketCarry = median(independent.map(p => p.change_7d).filter(Number.isFinite));
    const context = { typicalAge, marketCarry };
    const rng = randomFrom(29053);
    const comps = independentTokens(ledger.Priced).sort((a, b) => byText(a.slug, b.slug))
      .map(p => ({ ...prepare(p, context), y: Math.log(p.mcap_usd / p.tvl_usd) }));
    const shuffled = comps.map(p => p.carry);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    comps.forEach((p, i) => { p.x[5] = shuffled[i]; });
    const dated = independent.filter(p => p.age !== null && p.bucket !== 'Off-list');
    const oddsRows = [...independentTokens(dated.filter(p => p.recorded)), ...dated.filter(p => !p.recorded)]
      .sort((a, b) => byText(a.slug, b.slug)).map(p => prepare(p, context));
    const loo = leaveOneOut(comps);
    const forward = expanding(comps);
    const cap = capSelection(loo, forward);
    cap.evidence.push({ name: 'Shuffled 7d', control: true, scores: [loo, forward].map(split =>
      capStats(capErrors(split, [...cap.terms, 5]))) });
    const oddsSplits = [folds(oddsRows, 10), expanding(oddsRows)];
    const oddsStats = (terms, base) => oddsSplits.map(split => oddsErrors(split, terms, base));
    const odds = selectTerms(ODDS_TERMS, oddsStats, 'brier', 'Age / survival');
    odds.evidence.unshift({ name: 'Training base rate', scores: oddsStats([], true) });
    const errors = [ascending(capErrors(loo, cap.terms)), ascending(capErrors(forward, cap.terms))];
    const model = {
      comps, context, cap, odds, errors,
      audit: [intervalAudit(loo, false), intervalAudit(forward, true)],
      capFit: capFit(comps, cap.terms), oddsFit: oddsFit(oddsRows, odds.terms), draws: []
    };
    const sample = rows => rows.map(() => rows[Math.floor(rng() * rows.length)]);
    for (let i = 0; i < BOOTS; i++) {
      const pool = errors[i % 2].length ? errors[i % 2] : errors[0];
      model.draws.push({
        cap: capFit(sample(comps), cap.terms),
        odds: oddsFit(sample(oddsRows), odds.terms, 1.8 + rng() * 1.6),
        residual: quantile(pool, ((Math.floor(i / 2) * 37) % (BOOTS / 2) + 0.5) / (BOOTS / 2))
      });
    }
    const coefficient = (name, field, get) => ({
      name, value: get(model[field + 'Fit']), se: sd(model.draws.map(draw => get(draw[field])))
    });
    model.coefficients = [
      ...cap.terms.filter(j => j !== 1).map(j => coefficient(j ? 'Cap · ' + CAP_TERMS[j] : 'Cap · TVL elasticity', 'cap', f => f.beta[j] + Number(j === 0))),
      ...odds.terms.filter(j => j !== 0).map(j => coefficient('Odds · ' + ODDS_TERMS[j], 'odds', f => f.beta[j]))
    ];
    return model;
  }

  function impliedValue(p, model, withDraws = true) {
    const record = prepare(p, model.context, p.tvl_usd * p.parentShare);
    const cap = Math.exp(capLog(model.capFit, record));
    const odds = tokenOdds(record, model.oddsFit);
    const point = cap * odds.own;
    if (!withDraws || p.recorded) return { cap, odds, point, record };
    const draws = model.draws.map(fit => {
      const c = Math.exp(capLog(fit.cap, record));
      const o = tokenOdds(record, fit.odds).own;
      return { point: c * o, odds: o, scenario: c * o * Math.exp(fit.residual) };
    });
    const sample = ascending(draws.map(d => d.scenario));
    const oddsSample = ascending(draws.map(d => d.odds));
    return { cap, odds, point, record, draws, range: LIMITS.map(q => quantile(sample, q)),
      oddsRange: [quantile(oddsSample, 0.10), quantile(oddsSample, 0.90)] };
  }

  // USD per leg, entry, exit and check, plus variable fee per leg.
  const ROUTES = [
    [/^(Ethereum)$/, 'Ethereum L1', 12, 5, 8, 1, 0.00020],
    [/^(Bitcoin)$/, 'Bitcoin L1', 10, 6, 8, 2, 0.00025],
    [/^(Base|Arbitrum|Optimism|Ink|Polygon|Scroll|Linea|zkSync Era|Unichain|World Chain|Blast)$/, 'EVM rollup / sidechain', 3, 0.6, 1.2, 0.15, 0.00010],
    [/^(Solana|Sui|Aptos)$/, 'Low-fee L1', 2, 0.25, 0.55, 0.08, 0.00008],
    [/^(Monad|Bittensor|Hyperliquid L1|Sei|Flare|Berachain|Arc|Pharos)$/, 'Specialized L1', 4, 1.25, 2.25, 0.3, 0.00014]
  ];
  const ACTIONS = [
    [/allocator|curator|yield|liquidity manager/i, 'Supply a stable asset to an unlocked vault. Log its address, share price and exit queue.', 'Check share price, points and exit liquidity.'],
    [/lend|cdp|collateral/i, 'Supply a stable asset without leverage. Record utilization and test a withdrawal.', 'Check utilization, bad debt and withdrawal liquidity.'],
    [/dex|swaps/i, 'Test 5% of the ticket in the deepest eligible pool. Add the balance if the exit quote clears.', 'Log principal, points and an exit quote.'],
    [/basis|derivatives|options|synthetics/i, 'Check funding and redemption terms on a hedged vault. Enter only if liquidity supports an exit.', 'Check hedge drift, funding and exit liquidity.'],
    [/rwa|cedefi|insurance|prediction/i, 'Verify investor and region access before opening a withdrawable position.', 'Check withdrawal windows and eligibility.'],
    [/stak|token locker/i, 'Test a native position and confirm unlock and slash terms.', 'Check unlock delays, receipt discount and slash notices.'],
    [/stable/i, 'Verify reserves and test redemption before entering a savings position.', 'Log peg, reserves and a redemption quote.']
  ];

  function farmVerdict(net, hourly, gated) {
    if (net <= 0) return 'SKIP';
    if (gated || hourly < 20) return 'MARGINAL';
    return 'FARM';
  }

  function farmPlan(p, value, settings = DEFAULTS) {
    const chain = p.chains.find(name => ROUTES.some(([match]) => match.test(name))) || p.chains[0] || 'unlisted';
    const [, network, bridge, entry, exit, check, bps] = ROUTES.find(([match]) => match.test(chain)) ||
      [null, 'Unquoted L1', 7, 2, 4, 0.5, 0.00020];
    const action = ACTIONS.find(a => a[0].test(p.category));
    const days = Math.round(clamp(settings.days, 7, 182));
    const drop = clamp(settings.drop, 0, 0.30);
    const weeks = Math.ceil(days / 7);
    const freshness = p.age !== null && p.age < 0.5;
    const shock = p.change_7d !== null && p.change_7d <= -15;
    const gated = p.recorded || p.linked || !p.chains.length || !action ||
      /^(RWA|CeDeFi|Insurance|Prediction Market|Stablecoin Wrapper|Dual-Token Stablecoin|Chain)$/.test(p.category);
    const trigger = shock ? 0.15 : freshness ? 0.20 : 0.25;
    const floor = Math.round(p.tvl_usd * (1 - trigger));
    const cadence = shock ? 7 : 5;
    const minutes = 13 + 12 + 14 + 12 + weeks * cadence;
    const keep = 0.65 * Math.min(1, (days / 84) ** 0.65);
    const eligiblePool = p.tvl_usd * 0.12;
    const rate = value.point * keep / eligiblePool;
    const fixed = 2 * bridge + entry + exit + weeks * check;
    const charge = days / 365.25 * 0.04 + 2 * bps;
    const margin = rate * drop - charge;
    const hurdle = 20 * minutes / 60;
    const viable = margin > 0 ? (fixed + hurdle) / margin : Infinity;
    const size = Math.round(clamp(Math.max(0.0002 * p.tvl_usd, Number.isFinite(viable) && viable <= 25000 ? Math.ceil(viable / 100) * 100 : 0), 1000, 25000));
    const deposit = Math.round(settings.deposit > 0 ? clamp(settings.deposit, 100, 25000) : size);
    const capCost = 0.04 * days / 365.25 * deposit;
    const funding = bridge + deposit * bps;
    const unwind = bridge + deposit * bps + exit;
    const fees = funding + entry + weeks * check + unwind;
    const costs = fees + capCost;
    const expected = deposit * drop * rate;
    const net = expected - costs;
    const hourly = net / (minutes / 60);
    const lowNet = (value.range?.[1] ?? 0) * deposit * drop * keep / eligiblePool - costs;
    const crowdedNet = expected / 2 - costs;
    const shareBE = rate > 0 ? costs / (deposit * rate) : Infinity;
    const depositBE = margin > 0 ? fixed / margin : Infinity;
    const fee = x => x < 10 ? '$' + x.toFixed(2) : money(x);
    const steps = [
      ['Day 0', 'Verify access', `Check defillama.com/protocol/${p.slug}, then verify official contracts, access and withdrawals.`, '13 min · $0'],
      ['Day 0', 'Fund & bridge', `Fund ${money(deposit)} plus fees on ${chain}. Verify the asset and bridge, then test a small transfer.`, `12 min · ${fee(funding)}`],
      ['Day 0', 'Enter position', action?.[1] || 'Verify a qualifying position and its exit in the official app.', `14 min · ${fee(entry)}`],
      [`Weekly ×${weeks}`, 'Maintain & log', (action?.[2] || 'Check eligibility and exits.') + ' Save dated receipts. Transact if published rules require it.', `${cadence} min/wk · ${fee(weeks * check)}`],
      ['Any day', 'Stop rule', `Exit if TVL falls below ${money(floor)} (−${Math.round(trigger * 100)}%). Halt deposits if withdrawals pause or assets depeg.`, 'Exit fee reserved'],
      [`Day ${days}`, 'Unwind & claim', 'Withdraw, bridge back and revoke approvals. Claim from an official page when available.', `12 min · ${fee(unwind)}`],
      ['Budget', 'Fees & carry', `${fee(fees)} fees + ${fee(capCost)} at 4% annual capital charge. ${money(deposit)} stays exposed for ${days} days.`, `${minutes} min · ${fee(costs)}`]
    ];
    return { deposit, drop, days, chain, network, expected, net, hourly, lowNet, crowdedNet, gated,
      costs, minutes, shareBE, depositBE, verdict: farmVerdict(net, hourly, gated), steps };
  }

  function buildRadar(snapshot) {
    const ledger = ledgerOf(snapshot);
    const model = fitModel(ledger);
    const candidates = Object.values(ledger).slice(0, 3).flat().map(p => {
      const value = impliedValue(p, model);
      return { p, value, plan: farmPlan(p, value), implied: Math.max(1, Math.round(value.point)) };
    });
    candidates.sort((a, b) => b.implied - a.implied || byText(a.p.slug, b.p.slug));
    const active = candidates.filter(r => !r.p.recorded);
    active.forEach(r => { r.ranks = []; });
    for (let j = 0; j < BOOTS; j++) {
      active.sort((a, b) => b.value.draws[j].point - a.value.draws[j].point || byText(a.p.slug, b.p.slug))
        .forEach((r, i) => r.ranks.push(i + 1));
    }
    const board = { rows: candidates.map((r, i) => {
      r.rank = i + 1;
      const sorted = ascending(r.ranks || []);
      r.rankRange = sorted.length ? [0.1, 0.9].map(q => Math.round(quantile(sorted, q))) : null;
      return { slug: r.p.slug, name: r.p.name, rank: r.rank, cohort: r.p.bucket,
        token_status: r.p.recorded ? 'watchlist record exception' : 'records no token',
        implied_value_usd: r.implied,
        farm_steps: r.plan.steps.map(step => `${step[0]} · ${step[1]}. ${step[2]} ${step[3]}.`) };
    }) };
    return { ledger, model, candidates, board };
  }

  function nearestPeers(p, model, count = 4) {
    const r = prepare(p, model.context);
    const distance = q => Math.abs(q.storage - r.storage) + (q.category === r.category ? 0 : 2.5)
      + 0.15 * Math.abs(q.x[2] - r.x[2]);
    return [...model.comps].sort((a, b) => distance(a) - distance(b) || byText(a.slug, b.slug)).slice(0, count);
  }

  function plotCurve(tvl, model) {
    const record = { storage: Math.log(tvl / 5e7), category: '', x: [Math.log(tvl / 5e7), '', 0, 0, 0, 0] };
    const cap = capLog(model.capFit, record);
    const errors = ascending(model.errors.flat());
    return [Math.exp(cap), Math.exp(cap + quantile(errors, 0.25)), Math.exp(cap + quantile(errors, 0.75))];
  }

  return { ledgerOf, fitModel, tokenOdds, impliedValue, farmPlan, farmVerdict, buildRadar, nearestPeers, plotCurve, DEFAULTS, BOOTS };
});
