(() => {
  'use strict';
  const app = document.querySelector('#workspace');
  const data = globalThis.RadarData;
  if (!data) {
    app.textContent = 'Build first, then open out/dashboard/index.html.';
    app.removeAttribute('aria-busy');
    return;
  }
  const M = globalThis.RadarModel;
  const { snapshot, board, mainHash, mainSource } = data;
  const { ledger, model, candidates, board: rebuilt } = M.buildRadar(snapshot);
  const ranked = new Map(candidates.map(r => [r.p.slug, r]));
  const settings = { ...M.DEFAULTS };
  const ledgerLabels = ['Watchlist', 'Off-list / parent-linked', 'Early', 'Token trades', 'Recorded / unpriced', 'Excluded products'];
  const colors = ['#265cc7', '#7f5db0', '#4d9b83', '#d38a43', '#a16b68', '#9b9eaa'];
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const cash = n => Number.isFinite(n) ? usd.format(n) : '—';
  const decimal = (n, d = 2) => n.toFixed(d);
  const compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 });
  const compact = n => Number.isFinite(n) ? compactUsd.format(n) : '—';
  const pct = (n, d = 0) => Number.isFinite(n) ? decimal(n * 100, d) + '%' : '—';
  const change = n => n === null ? '—' : (n > 0 ? '+' : '') + decimal(n, 1) + '%';
  const age = p => p.age === null ? 'Unknown' : p.age < 0.5 ? Math.round(p.age * 365.25) + 'd' : decimal(p.age, 1) + 'y';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const signed = n => n > 0 ? '+' + cash(n) : cash(n);
  const tone = n => n >= 0 ? 'positive' : 'negative';
  const badge = s => `<span class="badge ${s.toLowerCase()}">${s}</span>`;
  const cohort = p => p.recorded ? 'Watchlist exception' : p.linked ? 'Parent-linked' : p.bucket;
  const protocolLink = r => '#protocol/' + encodeURIComponent(r.p.slug);
  const metrics = items => `<div class="metrics ${items.length === 6 ? 'six' : 'four'}">${items.map(([title, value, sub]) =>
    `<div class="metric"><span>${title}</span><strong>${value}</strong><small>${sub}</small></div>`).join('')}</div>`;
  const head = (title, fn, sub = '') => `<div class="panel-head"><div><h2>${title}</h2><p>${sub}</p></div>${fn ? `<code>${fn}()</code>` : ''}</div>`;
  const panel = (title, fn, body, sub) => `<section class="panel">${head(title, fn, sub)}${body}</section>`;
  const totals = rows => rows.reduce((total, r) => total + r.implied_value_usd, 0);
  const count = candidates.length;
  const matches = rebuilt.rows.filter((r, i) => JSON.stringify(r) === JSON.stringify(board.rows[i])).length;
  const ranksOK = board.rows.length === count && board.rows.every((r, i) =>
    r.rank === i + 1 && r.implied_value_usd <= (board.rows[i - 1]?.implied_value_usd ?? Infinity));
  const watchRows = snapshot.watchlist.filter(slug => ranked.has(slug)).length;
  const ledgerRows = new Set(Object.values(ledger).flat().map(p => p.slug)).size;
  const sumsOK = totals(rebuilt.rows) === totals(board.rows);
  const coverageOK = watchRows === snapshot.watchlist.length && ledgerRows === snapshot.protocols.length;
  const rowsOK = matches === count && count === board.rows.length;
  let checksum = null;
  let state;
  let route = '';

  async function verifyChecksum() {
    try {
      const bytes = new TextEncoder().encode(JSON.stringify([mainSource, snapshot, rebuilt]));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const actual = new DataView(digest).getUint32(0).toString(16).padStart(8, '0');
      checksum = actual === mainHash;
    } catch {
      checksum = false;
    }
    const strip = document.querySelector('.integrity');
    if (strip) strip.outerHTML = integrity();
    app.dataset.verified = String(checksum && rowsOK && ranksOK && sumsOK && coverageOK);
  }

  function integrity() {
    const checks = [
      [rowsOK, `${matches}/${count} rows recomputed here = board.json`],
      [ranksOK, `ranks 1–${count}, values never rise`],
      [sumsOK, `totals equal: ${cash(totals(board.rows))}`],
      [checksum, `checksum ${esc(mainHash)} = main.ts + data`],
      [coverageOK, `watchlist ${watchRows}/${snapshot.watchlist.length} · ledger ${ledgerRows}/${snapshot.protocols.length} protocols`]
    ];
    return `<div class="integrity">${checks.map(([pass, text]) =>
      `<span class="${pass === false ? 'failed' : ''}"><b>${pass === null ? '…' : pass ? '✓' : '✕'}</b> ${text}</span>`).join('')}</div>`;
  }

  function header() {
    const active = ['trades', 'method'].includes(route) ? route : 'board';
    document.querySelector('#top').innerHTML = `<div class="top-inner">
      <a class="wordmark" href="#board"><i>↗</i> Forward Window <sup>v3</sup></a>
      <nav>${Object.entries({ board: 'Board', trades: 'Token trades', method: 'Method' }).map(([key, label]) =>
        `<a href="#${key}" ${active === key ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
      <div class="stamp">SEALED SNAPSHOT <time>${esc(snapshot.as_of)}</time></div></div>`;
  }

  const intro = (title, sub, side = '') => `<div class="intro"><div><h1>${title}</h1><p>${sub}</p></div>${side}</div>`;
  function matrix(headers, rows, kind = 'mini') {
    return `<table class="${kind}"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([name, ...cells]) => `<tr><th scope="row">${name}</th>${cells.map(c =>
        Array.isArray(c) ? `<td class="${c[1]}">${c[0]}</td>` : `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function scatter(selected) {
    const x = v => 60 + (Math.log10(v) - 6) * 113;
    const y = v => 230 - (Math.log10(Math.max(v, 1)) - 3) * 29;
    const gridX = [1e7, 1e8, 1e9, 1e10].map(v => `<path d="M${x(v)} 26V230"/><text x="${x(v)}" y="249">${compact(v)}</text>`);
    const gridY = [1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10].map(v => `<path d="M60 ${y(v)}H512"/><text x="51" y="${y(v) + 4}">${compact(v)}</text>`);
    const coords = [5e6, 1e7, 1e10].map(tvl => [x(tvl), ...M.plotCurve(tvl, model).map(y)]);
    const line = (j, points = coords) => points.map(p => [p[0], p[j]].join(',')).join(' ');
    const dot = (p, cap, cls, radius) => `<circle cx="${x(p.tvl_usd)}" cy="${y(cap)}" r="${radius}" class="${cls}"><title>${esc(p.name)}</title></circle>`;
    const hi = selected && [x(selected.p.tvl_usd), y(selected.value.cap)];
    return `<section class="panel chart">${head('Cap vs TVL', 'fitModel', 'Log–log · USD')}
      <svg viewBox="0 0 538 270" role="img" aria-label="Log-log chart of token caps against TVL">
      <g class="chart-grid"><g text-anchor="end">${gridY.join('')}</g><g text-anchor="middle">${gridX.join('')}</g></g>
      <polygon class="quantile" points="${line(2, coords)} ${line(3, [...coords].reverse())}"/>
      <polyline class="fit" points="${line(1)}"/>
      ${model.comps.map(p => dot(p, p.mcap_usd, 'comp', 3)).join('')}
      ${candidates.filter(r => !r.p.recorded).map(r => dot(r.p, r.value.cap, 'candidate', 2.4)).join('')}
      ${hi ? `<path class="crosshair" d="M${hi[0]} 26V230M60 ${hi[1]}H512"/>${dot(selected.p, selected.value.cap, 'selected', 6)}
      <text class="selection" x="${Math.min(hi[0] + 12, 380)}" y="${hi[1] - 13}">${esc(selected.p.name)}</text>` : ''}
      <text x="511" y="265" text-anchor="end" class="axis">TVL →</text></svg>
      <div class="legend">${Object.entries({comp: 'Priced peer', candidate: 'Board cap', fit: 'Pooled fit', quantile: 'Cap P25–P75'}).map(([cls, label]) =>
        `<span><i class="${cls}"></i> ${label}</span>`).join('')}</div></section>`;
  }

  function evidence(which) {
    const cap = which === 'cap';
    const headers = cap ? ['Cap term', 'LOO miss · ≤×3', 'Forward miss · ≤×3'] : ['Census status', '10-fold Brier', 'Forward Brier'];
    return matrix(headers, model[which].evidence.map((line, i) => [line.name + (i ?
      line.control ? ' <em>Control</em>' : line.kept ? ' <em class="positive">Kept</em>' : ' <em>Tested</em>' : ''),
    ...line.scores.map(s => cap ? `×${decimal(s.miss)} <small>· ${pct(s.within)}</small>` : decimal(s.brier, 4))]), 'evidence');
  }

  function rangeEvidence() {
    const [loo, wf] = model.audit;
    return `<div class="range-audit"><b>Is the printed range honest?</b>
      ${matrix(['Cap interval', 'LOO · n=' + loo.n, 'Forward · n=' + wf.n],
        ['P25–P75 · 50%', 'P10–P90 · 80%'].map((label, i) => [label, pct(loo.hits[i], 1), pct(wf.hits[i], 1)]), 'evidence')}
      <p>Cap hits only. Joint bands vary scenario odds.</p></div>`;
  }

  function coefficientEvidence() {
    return `<p class="footnote">Bootstrap coefficients ± s.e. · ${M.BOOTS} refits</p><div class="coefficients">${model.coefficients.map(c =>
      `<span>${c.name} <b>${decimal(c.value, 3)} ± ${decimal(c.se, 3)}</b></span>`).join('')}</div>`;
  }

  function ledgerBar() {
    const sizes = Object.values(ledger).map(rows => rows.length);
    return `<section class="ledger panel">${head('Protocol accounting', 'ledgerOf')}
      <div class="ledger-bar">${sizes.map((n, i) => `<i style="flex:${n};background:${colors[i]}"></i>`).join('')}</div>
      <div class="ledger-legend">${sizes.map((n, i) => `<span><i style="background:${colors[i]}"></i> <b>${n}</b> ${ledgerLabels[i]}</span>`).join('')}</div></section>`;
  }

  function controls() {
    const inputs = [['deposit', 'Deposit · USD', 100, 25000, 100, settings.deposit || ''],
      ['drop', 'Drop share · %', 0, 30, 0.5, decimal(settings.drop * 100, 1)],
      ['days', 'Hold · days', 7, 182, 7, settings.days]];
    return `<div class="controls"><div><span class="field-label">Presets</span><div class="segmented">
      ${[0, 1000, 10000, 25000].map(n => `<button data-deposit="${n}" aria-pressed="${settings.deposit === n}">${n ? compact(n) : 'Plan size'}</button>`).join('')}
      </div></div>${inputs.map(([key, label, min, max, step, value]) => `<label>${label}<input type="number"
      data-setting="${key}" min="${min}" max="${max}" step="${step}" placeholder="Auto" value="${value}"></label>`).join('')}
      <p>0.02% of TVL · $1K–$25K · may increase to clear $20/h</p></div>`;
  }

  function steps(plan) {
    return `<ol class="steps">${plan.steps.map(([when, label, description, cost]) =>
      `<li><time>${when}</time><div><strong>${label}</strong><p>${esc(description)}</p></div><small>${cost}</small></li>`).join('')}</ol>`;
  }

  function economics(plan) {
    const fields = [['Ticket · horizon', cash(plan.deposit) + ' · ' + plan.days + 'd'], ['Expected reward', cash(plan.expected)],
      ['Fees + carry', cash(plan.costs)], ['P25 net', signed(plan.lowNet), tone(plan.lowNet)],
      ['Break-even drop', pct(plan.shareBE, 2)], ['Break-even deposit', cash(plan.depositBE)]];
    return `<div class="economics">${fields.map(([name, value, cls]) =>
      `<div><span>${name}</span><b class="${cls || ''}">${value}</b></div>`).join('')}</div>`;
  }

  const planFor = r => M.farmPlan(r.p, r.value, settings);
  function planNotes(plan) {
    return `<p class="plan-note">2× eligible liquidity net <b class="${tone(plan.crowdedNet)}">${signed(plan.crowdedNet)}</b> ·
      ${plan.lowNet <= 0 ? 'P25 loses money' : 'P25 covers costs'}${plan.gated ? ' · Verify access and eligibility' : ''}</p>`;
  }

  const columns = [
    ['Rank', r => r.rank], ['Protocol'], ['Cohort'], ['TVL', r => r.p.tvl_usd], ['7d', r => r.p.change_7d ?? -Infinity],
    ['Implied value', r => r.implied], ['24m odds', r => r.value.odds.own], ['Ticket'],
    ['Net / hr', r => r.plan.hourly], ['Verdict']
  ];
  function filterControls() {
    const select = (key, label, values) => `<select data-filter="${key}" aria-label="${label}">
      ${['', ...values].map(v => `<option value="${esc(v)}" ${v === state[key] ? 'selected' : ''}>${esc(v || label)}</option>`).join('')}</select>`;
    return `<div class="filters">
      <input type="search" data-filter="q" value="${esc(state.q)}" placeholder="Find protocol or chain" aria-label="Find protocol or chain">
      ${select('group', 'All cohorts', ['Watchlist', 'Early', 'Off-list'])}
      ${select('verdict', 'All verdicts', ['FARM', 'MARGINAL', 'SKIP'])}
      <a class="button focus-link" href="${route === 'focus' ? '#board' : '#focus'}">${route === 'focus' ? 'Clear focus' : 'Focus: Early + FARM'} ↗</a>
    </div>`;
  }

  function expanded(r) {
    return `<tr class="expanded"><td colspan="10">
      <div class="expanded-head"><strong>${esc(r.p.name)} execution plan <code>farmPlan()</code></strong>
      <a class="button" href="${protocolLink(r)}">Open protocol ↗</a></div>
      ${economics(r.plan)}${steps(r.plan)}${planNotes(r.plan)}
    </td></tr>`;
  }

  function boardTable() {
    const sortKey = columns[state.sort][1];
    const query = state.q.trim().toLowerCase();
    const matching = candidates.map(r => ({ ...r, plan: planFor(r) })).filter(r =>
      (!state.group || state.group === r.p.bucket) && (!state.verdict || state.verdict === r.plan.verdict) &&
      (!query || [r.p.name, r.p.slug, r.p.category, ...r.p.chains].join(' ').toLowerCase().includes(query))
    ).sort((a, b) => state.dir * (sortKey(a) - sortKey(b)) || a.rank - b.rank);
    const perPage = route === 'focus' ? 13 : 6;
    const last = Math.max(0, Math.ceil(matching.length / perPage) - 1);
    state.page = Math.min(last, state.page);
    const offset = state.page * perPage;
    const rows = matching.slice(offset, offset + perPage);
    const open = state.open ?? (rows.find(r => r.plan.verdict === 'FARM') || rows.find(r => r.plan.verdict === 'MARGINAL'))?.p.slug;
    return `<div class="table-scroll"><table class="rank-table">
      <thead><tr>${columns.map(([label, key], i) => {
        const sorted = state.sort === i;
        return `<th ${sorted ? `aria-sort="${state.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${key ?
          `<button data-sort="${i}">${label}${sorted ? state.dir > 0 ? ' ↑' : ' ↓' : ''}</button>` : label}</th>`;
      }).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr class="${open === r.p.slug ? 'open' : ''}">
        <td><button class="expand" data-open="${esc(r.p.slug)}" aria-expanded="${open === r.p.slug}" aria-label="Toggle plan for ${esc(r.p.name)}">
          <span>${open === r.p.slug ? '−' : '+'}</span> ${String(r.rank).padStart(2, '0')}</button></td>
        <th scope="row"><a href="${protocolLink(r)}">${esc(r.p.name)}</a><small>${esc(r.p.category)} · ${esc(r.plan.chain)}</small></th>
        <td><span class="cohort ${r.p.bucket.toLowerCase()}">${cohort(r.p)}</span></td><td>${compact(r.p.tvl_usd)}</td>
        <td class="${r.p.change_7d === null ? '' : tone(r.p.change_7d)}">${change(r.p.change_7d)}</td>
        <td><b>${r.p.recorded ? '—' : compact(r.implied)}</b></td><td>${pct(r.value.odds.own)}</td><td>${cash(r.plan.deposit)}</td>
        <td class="${tone(r.plan.hourly)}"><b>${signed(r.plan.hourly)}</b></td><td>${badge(r.plan.verdict)}</td>
      </tr>${open === r.p.slug ? expanded(r) : ''}`).join('') || '<tr><td colspan="10">No matching protocols.</td></tr>'}</tbody>
      </table></div>
      <div class="pager"><span>${matching.length ? offset + 1 + '–' + (offset + rows.length) : '0'} of ${matching.length} matching · ${count} ranked</span>
      <div>${[-1, 1].map((n, i) => `<button data-page="${n}" ${state.page === (i ? last : 0) ? 'disabled' : ''}>${i ? 'Next' : 'Prev'}</button>`).join(' ')}</div></div>`;
  }

  function boardView(focus) {
    const c = model.cap;
    const base = c.evidence[0].scores[1].miss;
    const counts = Object.groupBy(candidates.filter(r => !focus || r.p.bucket === 'Early').map(planFor), p => p.verdict);
    const farms = counts.FARM || [];
    const summary = focus ? [
      ['Early FARM', farms.length, 'Below the watchlist floor'],
      ['Top net / hour', signed(Math.max(0, ...farms.map(p => p.hourly))), 'Active time across the hold'],
      ['P25 net positive', farms.filter(p => p.lowNet > 0).length, 'Of the Early FARM plans'],
      ['Labor hurdle', '$20 / h', 'Positive net · ungated route']
    ] : [
      ['Walk-forward cap miss', '×' + decimal(c.best[1].miss), 'vs ×' + decimal(base) + ' flat multiple'],
      ['Range honesty · forward', model.audit[1].hits.map(p => pct(p)).join(' / '), 'P25–P75 and P10–P90 cap hits'],
      ['Token odds Brier · 10-fold', decimal(model.odds.best[0].brier, 4), 'vs ' + decimal(model.odds.evidence[0].scores[0].brier, 4) + ' base rate'],
      ['Terms kept', c.terms.length + ' cap / ' + (model.odds.terms.length + 1) + ' odds', 'Dual holdout test'],
      ['Worth farming', farms.length + ' FARM', (counts.MARGINAL?.length || 0) + ' marginal · P25 downside shown'],
      ['Watchlist coverage', watchRows + '/' + snapshot.watchlist.length, count + ' ranked · ' + ledgerRows + ' accounted']
    ];
    return intro(focus ? 'Early farming opportunities' : 'Token launch radar',
        focus ? 'Below $50M TVL · FARM · highest net per active hour first.' :
        'Cap if launched × conditional 24-month own-token odds.',
      focus ? '<a class="button" href="#board">← Full board</a>' : '<a class="button" href="#method">Methods ↗</a>') +
      metrics(summary) +
      (focus ? '' : `<div class="evidence-layout">
        ${panel('Out-of-sample cap evidence', 'fitModel', evidence('cap') + coefficientEvidence(), model.comps.length + ' independent peers · terms must lower both median misses')}
        ${panel('Odds & range calibration', 'tokenOdds', evidence('odds') + rangeEvidence(), 'Brier measures current token status · lower is better')}
        ${scatter()}</div>${ledgerBar()}${integrity()}`) +
      `<section class="panel board-panel">${head(focus ? 'Early FARM shortlist' : 'Ranked launch board', 'impliedValue')}
      ${controls()}${filterControls()}<div id="table-region">${boardTable()}</div></section>` +
      '<footer>DefiLlama sealed snapshot · USD · Model scenarios for research and execution planning.</footer>';
  }

  function waterfall(r) {
    const { p, value } = r;
    const o = value.odds;
    const bands = value.range;
    const rows = [
      ['TVL', compact(p.tvl_usd), 'Cap scale'],
      ['7-day TVL growth', change(p.change_7d), 'Market-relative odds term'],
      ['Time with no token recorded', p.recorded ? 'Recorded' : age(p), p.age === null ? 'Median age used' : 'Conditions survival'],
      ['Category', esc(p.category), 'Cap / odds term test'],
      ['Chain count', p.chains.length, 'Cap term test'],
      ['Conditional cap', compact(value.cap), pct(p.parentShare) + ' of TVL enters fit', 1],
      ['P now → P +24m', pct(o.now, 1) + ' → ' + pct(o.later, 1), 'Peer status curve'],
      ['Conditional own-token odds', pct(o.own, 1), 'Survival × ' + pct(p.own) + ' own-token share', o.own],
      ['Implied launch value', p.recorded ? 'Coverage record' : compact(r.implied), 'Conditional cap × own-token odds', o.own]
    ];
    return matrix(['Input', 'Reading', 'Effect'], rows.map(([name, reading, effect, weight]) =>
      [name, weight === undefined ? reading : `<b>${reading}</b> <meter max="1" value="${weight}"></meter>`, effect]), 'mini waterfall') +
      (bands ? `<p class="footnote">P25–P75 <b>${compact(bands[1])}–${compact(bands[3])}</b> ·
      P10–P90 <b>${compact(bands[0])}–${compact(bands[4])}</b></p>` : '');
  }

  function peers(r) {
    return matrix(['Priced token family', 'TVL', 'Trade cap', 'Cap / TVL'], M.nearestPeers(r.p, model).map(p =>
      [esc(p.name) + ' <small>' + esc(p.category) + '</small>', compact(p.tvl_usd), compact(p.mcap_usd), '×' + decimal(p.mcap_usd / p.tvl_usd)]));
  }

  function changed(r) {
    const p = r.p;
    const tests = [['TVL −30%', { tvl_usd: p.tvl_usd * 0.7 }], ['7d TVL change = 0%', { change_7d: 0 }],
      ['7d TVL change = +20%', { change_7d: 20 }], ['+6 months with no token recorded', { age: r.value.record.modelAge + 0.5 }]];
    return matrix(['Change to one input', 'Cap', 'Odds', 'Implied', 'Δ value'], tests.map(([label, delta]) => {
      const v = M.impliedValue({ ...p, ...delta }, model, false);
      const diff = r.value.point ? (v.point / r.value.point - 1) : null;
      return [label, compact(v.cap), pct(v.odds.own, 1), compact(v.point), [(diff > 0 ? '+' : '') + pct(diff, 1), tone(diff)]];
    }));
  }

  function sensitivities(r, plan) {
    const calc = (deposit, drop, days) => M.farmPlan(r.p, r.value, { deposit, drop, days });
    const shares = [0.04, 0.08, 0.12, 0.16];
    const tickets = [1000, 5000, 10000, 25000];
    const days = [28, 56, 91, 182];
    const cell = (value, active) => [signed(value), 'heat ' + tone(value) + (active ? ' current' : '')];
    return `<div class="sens"><h3>Deposit × drop share</h3><p>Modeled net after fees and carry at ${plan.days} days</p>
      ${matrix(['Ticket', ...shares.map(s => pct(s))], tickets.map(ticket => [cash(ticket), ...shares.map(s =>
        cell(calc(ticket, s, plan.days).net, ticket === plan.deposit && s === plan.drop))]))}
      <h3>Hold-horizon sensitivity</h3><p>${cash(plan.deposit)} ticket · ${pct(plan.drop, 1)} drop share</p>
      ${matrix(['Hold', ...days.map(d => d / 7 + 'w')], [['Net', 'net'], ['Net / hr', 'hourly']].map(([label, key]) =>
        [label, ...days.map(d => cell(calc(plan.deposit, plan.drop, d)[key], plan.days === d))]))}</div>`;
  }

  function detailView(r) {
    if (!r) return intro('Protocol unavailable', 'Choose a protocol from the board.');
    const p = r.p;
    const plan = planFor(r);
    const nav = `<div class="detail-nav">${[-1, 1].map((direction, i) => {
      const other = candidates[r.rank + direction - 1];
      return other ? `<a class="button" href="${protocolLink(other)}">${i ? 'Next →' : '← Prev'}</a>` : '';
    }).join('')}</div>`;
    return intro(esc(p.name),
      `Rank ${r.rank}/${count} · ${cohort(p)} · ${esc(p.category)} · ${esc(plan.chain)} · ${p.recorded ? 'Token recorded' : 'Records no token'}`, nav) +
      metrics([
        ['TVL', compact(p.tvl_usd), '7d TVL change ' + change(p.change_7d)],
        ['Implied launch value', p.recorded ? '—' : compact(r.implied), r.rankRange ? 'Bootstrap rank ' + r.rankRange.join('–') + ' · P10–P90' : 'Watchlist coverage only'],
        ['Conditional 24m odds', pct(r.value.odds.own, 1), r.value.oddsRange ? 'Scenario P10–P90 ' + r.value.oddsRange.map(n => pct(n)).join('–') : 'Token recorded'],
        ['Net per active hour', signed(plan.hourly), badge(plan.verdict) + ' · ' + plan.minutes + ' min total']
      ]) + `<div class="detail-top">${panel('How the record becomes a value', 'impliedValue', waterfall(r))}${scatter(r)}</div>
      <div class="detail-mid">${panel('Nearest priced peers', 'fitModel', peers(r), 'Category and log-TVL distance')}
      ${panel('What moves impliedValue() on a changed record', '', changed(r), 'One change · fixed coefficients')}</div>
      <div class="detail-bottom">
        ${panel('Seven-step farm plan', 'farmPlan', economics(plan) + steps(plan) + planNotes(plan), esc(plan.network) + ' · estimated costs')}
        ${panel('Farm sensitivity', 'farmVerdict', controls() + sensitivities(r, plan), 'FARM requires positive net and ≥ $20/hr.')}
      </div><footer>Confirm product access, eligibility and exit terms before funding.</footer>`;
  }

  function tradesView() {
    const leads = new Set(model.comps.map(p => p.slug));
    const rows = [...ledger.Priced, ...ledger.Unpriced, ...ledger.Watchlist.filter(p => p.recorded)]
      .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0));
    return intro('Token trades', 'Recorded token data') + ledgerBar() +
      matrix(['Protocol', 'Token ID', 'TVL', 'Reported cap', 'Priced peer'], rows.map(p =>
        [esc(p.name), esc(p.symbol || p.gecko_id || '—'), compact(p.tvl_usd), compact(p.mcap_usd), leads.has(p.slug) ? 'Yes' : '—']));
  }

  function methodView() {
    const protocol = ledger.Watchlist.find(p => p.recorded);
    const methods = [
      ['Cap', 'fitModel', 'Huber ridge on log(cap / TVL). Forward folds hold out newer listings at one census. Nested bands use training residuals.'],
      ['Odds', 'tokenOdds', '(P +24m − P now) / (1 − P now). Weibull priors: shape 0.78, scale 2.6 years.'],
      ['Accounting', 'ledgerOf', `${esc(protocol?.name)} records a token ($1 sentinel). Off-list odds ×60%. Inferred parent links ×30%, with TVL shared. Stable receipts model separate governance launches.`],
      ['Farm', 'farmVerdict', 'Reward = implied × drop × ticket ÷ (12% of TVL) × credit capped at 65%. FARM is ungated and clears $20/h. MARGINAL is positive net. SKIP has net ≤0.']
    ];
    return intro('Methods', 'Census validation and launch scenarios.') +
      `<div class="method-grid">${methods.map(([title, fn, body]) => panel(title, fn, `<p>${body}</p>`)).join('')}</div>${integrity()}`;
  }

  function render() {
    header();
    app.className = route === 'focus' ? 'focus-view' : '';
    app.innerHTML = route.startsWith('protocol/') ? detailView(ranked.get(route.slice(9))) :
      route === 'trades' ? tradesView() : route === 'method' ? methodView() : boardView(route === 'focus');
    app.removeAttribute('aria-busy');
  }

  function navigate() {
    try { route = decodeURIComponent(location.hash.slice(1)) || 'board'; } catch { route = 'board'; }
    const focus = route === 'focus';
    state = { group: focus ? 'Early' : '', verdict: focus ? 'FARM' : '',
      q: '', sort: focus ? 8 : 0, dir: focus ? -1 : 1, page: 0, open: null };
    render();
    window.scrollTo(0, 0);
  }

  function refreshTable(reset = false) {
    if (reset) Object.assign(state, { page: 0, open: null });
    document.querySelector('#table-region').innerHTML = boardTable();
  }
  function updateField({ target }, live) {
    const { filter, setting } = target.dataset;
    if (filter && (filter === 'q') === live) {
      state[filter] = target.value;
      refreshTable(true);
    } else if (setting && !live) {
      settings[setting] = target.value === '' ? M.DEFAULTS[setting] :
        Math.max(+target.min, Math.min(+target.max, +target.value)) / (setting === 'drop' ? 100 : 1);
      render();
      app.querySelector(`[data-setting="${setting}"]`).focus({ preventScroll: true });
    }
  }
  app.addEventListener('input', event => updateField(event, true));
  app.addEventListener('change', event => updateField(event, false));
  app.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button) return;
    const { deposit, sort, open, page } = button.dataset;
    if (deposit !== undefined) {
      settings.deposit = Number(deposit);
      render();
      document.querySelector(`[data-deposit="${deposit}"]`)?.focus({ preventScroll: true });
    } else if (sort) {
      state.dir = state.sort === +sort ? -state.dir : +sort === 0 ? 1 : -1;
      state.sort = +sort;
      refreshTable(true);
      app.querySelector(`[data-sort="${sort}"]`).focus({ preventScroll: true });
    } else if (open) {
      state.open = button.getAttribute('aria-expanded') === 'true' ? '' : open;
      refreshTable();
      app.querySelector(`[data-open="${CSS.escape(open)}"]`)?.focus({ preventScroll: true });
    } else if (page) {
      state.page += Number(page);
      state.open = null;
      refreshTable();
      document.querySelector('.board-panel')?.scrollIntoView({ block: 'start' });
    }
  });
  addEventListener('hashchange', navigate);
  navigate();
  verifyChecksum();
})();
