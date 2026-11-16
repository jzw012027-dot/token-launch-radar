/* Token Launch Radar — board, detail and filter views over window.RADAR (../data.js).
   No network, no imports: everything renders from the snapshot data the program wrote. */
(function () {
  'use strict';
  var R = window.RADAR;
  var view = document.getElementById('view');
  if (!R || !view) { if (view) view.innerHTML = '<p class="empty">No radar data: run the program first.</p>'; return; }
  var rows = R.rows, live = R.live, M = R.model, stats = R.stats;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt$(v) {
    if (v == null) return '—';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + v;
  }
  function fmtPct(v) { return v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%'; }
  function pctCls(v) { return v == null || v === 0 ? 'flat' : v > 0 ? 'pos' : 'neg'; }
  function fmtAge(d) { return d == null ? '—' : d >= 730 ? (d / 365).toFixed(1) + 'y' : d + 'd'; }
  function fmtMult(v) { return v == null ? '—' : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0') + '×'; }
  function multOf(cat) {
    for (var i = 0; i < stats.multiples.length; i++) if (stats.multiples[i].category === cat) return stats.multiples[i];
    return null;
  }

  /* ---------- static chrome: header, model banner, live set, footer ---------- */
  document.getElementById('ver').textContent = 'MODEL ' + R.model_version.toUpperCase();
  document.getElementById('tagline').innerHTML =
    'Every protocol in the snapshot that <b>records no token</b>, ranked by what its launch would be worth ' +
    'under the model below — each with the steps to farm it. Snapshot of <b>' + esc(R.as_of) + '</b>. ' +
    'Protocols whose token already trades are the yardstick at the bottom of the page, not the board.';
  document.getElementById('funnel').innerHTML =
    '<span class="chip"><b>' + R.board_size + '</b> protocols ranked</span>' +
    '<span class="chip">watchlist <b>' + R.watchlist_size + '/' + R.watchlist_size + '</b> covered</span>' +
    '<span class="chip"><b>' + R.early_size + '</b> early finds below the $50M floor</span>' +
    '<span class="chip">multiples measured on <b>' + stats.sample_size + '</b> live-token protocols</span>' +
    '<span class="chip warn"><b>' + R.live_size + '</b> live references shown</span>';

  var wild = 0;
  rows.concat(live).forEach(function (r) { if (r.change_7d != null) wild = Math.max(wild, r.change_7d); });
  var mults = stats.multiples.slice().sort(function (a, b) { return a.category < b.category ? -1 : 1; });
  document.getElementById('model').innerHTML =
    '<h2>THE MODEL — HOW EVERY IMPLIED VALUE IS DERIVED <span class="sub">no name is weighted by hand</span></h2>' +
    '<p class="formula">implied <span class="op">=</span> <span class="v">TVL</span> <span class="op">×</span> ' +
    '<span class="f">category multiple</span> <span class="op">×</span> <span class="f">momentum</span> ' +
    '<span class="op">×</span> <span class="f">maturity</span> <span class="op">×</span> <span class="f">reach</span></p>' +
    '<div class="factors">' +
    '<div class="factor"><h3>1 · BASE <span>category multiple</span></h3><p>Median market-cap / TVL of the ' +
      stats.sample_size + ' live-token protocols in this snapshot that report both figures, taken per category. ' +
      'Categories with fewer than ' + M.min_category_samples + ' samples use the global median, ' + stats.global_multiple +
      '×. Every multiple is clamped to [' + M.multiple_floor + ', ' + M.multiple_cap + '].</p></div>' +
    '<div class="factor"><h3>2 · MOMENTUM <span>×0.83 – ×1.35</span></h3><p>7-day TVL change, clamped to [' +
      M.growth_floor + '%, +' + M.growth_cap + '%] and weighted ' + M.growth_weight + ': the factor is 1 + ' +
      M.growth_weight + ' × change. The snapshot\'s wildest print (' + fmtPct(wild) + ') is clamped, not believed.</p></div>' +
    '<div class="factor"><h3>3 · MATURITY <span>×' + M.maturity_floor + ' – ×' + (M.maturity_floor + M.maturity_range) +
      '</span></h3><p>Days since the protocol was first tracked, capped at ' + M.maturity_days + ': the longer it has run ' +
      'with no token recorded, the more value it has had time to accumulate. Unknown listing dates use the median age, ' +
      stats.median_age_days + ' days.</p></div>' +
    '<div class="factor"><h3>4 · REACH <span>×1.00 – ×' + (1 + M.chain_step * M.chain_max_extra) +
      '</span></h3><p>+' + M.chain_step + ' for each chain beyond the first, up to ' + M.chain_max_extra +
      ' extra chains: a protocol already live everywhere has more surface for a launch.</p></div>' +
    '</div>' +
    '<div class="multbox">' + mults.map(function (m) {
      return '<div><span>' + esc(m.category) + '</span><span><b>' + m.multiple.toFixed(4) + '×</b> n=' + m.samples +
        (m.fallback ? ' <span class="fb">GLOBAL</span>' : '') + '</span></div>';
    }).join('') + '</div>' +
    '<p class="modelnote">Implied values are rounded to the nearest $1K and floored at $1M. Every figure on this page is ' +
    'computed from the snapshot itself; open any protocol to see its four factors multiplied out, step by step.</p>';

  document.getElementById('livewrap').innerHTML =
    '<h2>ALREADY TRADING — THE REFERENCE SET <span class="sub">the yardstick the multiples are measured on; never ranked</span></h2>' +
    '<table><thead><tr><th>Protocol</th><th>Category</th><th class="r">TVL</th><th class="r">Market cap</th>' +
    '<th class="r">mcap ÷ TVL</th><th class="r">7d</th></tr></thead><tbody>' +
    live.map(function (p) {
      return '<tr><td><span class="pname">' + esc(p.name) + '</span></td><td class="cat">' + esc(p.category || '—') +
        '</td><td class="r num">' + fmt$(p.tvl_usd) + '</td><td class="r num">' + fmt$(p.mcap_usd) +
        '</td><td class="ratio">' + (p.mcap_tvl == null ? '—' : p.mcap_tvl.toFixed(2) + '×') +
        '</td><td class="r num ' + pctCls(p.change_7d) + '">' + fmtPct(p.change_7d) + '</td></tr>';
    }).join('') + '</tbody></table>';

  document.getElementById('foot').innerHTML =
    '<p>A protocol here <b>records no token</b> in the snapshot\'s source data — that is a statement about the record, ' +
    'not proof the protocol has no token, and not a prediction that one will launch. An implied value is this model\'s ' +
    'claim about what a launch would be worth if the record stayed as it is.</p>' +
    '<p>Farm plans are generated per protocol from its category and main chain: the action, what it costs and how long ' +
    'it takes. This page renders entirely offline from the snapshot of ' + esc(R.as_of) + '.</p>';

  /* ---------- board state, filters, sorting ---------- */
  var logMin = Math.log10(rows[rows.length - 1].implied_value_usd), logMax = Math.log10(rows[0].implied_value_usd);
  function heat(v) {
    var t = (Math.log10(v) - logMin) / Math.max(1e-9, logMax - logMin);
    var h = 196 - 151 * t; /* steel blue -> amber */
    return 'background:hsla(' + h.toFixed(0) + ',85%,52%,' + (0.08 + 0.30 * t).toFixed(2) + ');color:#fff';
  }
  function uniqCounts(get) {
    var map = {};
    rows.forEach(function (r) { get(r).forEach(function (k) { if (k) map[k] = (map[k] || 0) + 1; }); });
    return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || (a < b ? -1 : 1); })
      .map(function (k) { return { k: k, n: map[k] }; });
  }
  var CATS = uniqCounts(function (r) { return [r.category]; });
  var CHAINS = uniqCounts(function (r) { return r.chains; });
  var TVLS = [
    { v: '0', t: 'Any TVL' }, { v: '1000000000', t: 'TVL ≥ $1B' }, { v: '250000000', t: 'TVL ≥ $250M' },
    { v: '50000000', t: 'TVL ≥ $50M (the floor)' }, { v: '-50000000', t: 'TVL < $50M (early)' }
  ];
  var SORTS = [
    { v: 'rank', t: 'Sort: model rank' }, { v: 'tvl', t: 'Sort: TVL' }, { v: 'chg', t: 'Sort: 7d change' },
    { v: 'age', t: 'Sort: age' }, { v: 'mult', t: 'Sort: category multiple' }
  ];
  function defState() { return { q: '', cat: '', chain: '', tvl: '0', wl: false, sort: 'rank' }; }
  function stateFromHash() {
    var s = defState(), h = location.hash.replace(/^#\/?/, '');
    if (h.indexOf('board?') === 0) {
      var q = new URLSearchParams(h.slice(6));
      s.q = q.get('q') || ''; s.cat = q.get('cat') || ''; s.chain = q.get('chain') || '';
      s.tvl = q.get('tvl') || '0'; s.wl = q.get('wl') === '1'; s.sort = q.get('sort') || 'rank';
    }
    return s;
  }
  function hashOf(s) {
    var q = new URLSearchParams();
    if (s.q) q.set('q', s.q); if (s.cat) q.set('cat', s.cat); if (s.chain) q.set('chain', s.chain);
    if (s.tvl !== '0') q.set('tvl', s.tvl); if (s.wl) q.set('wl', '1'); if (s.sort !== 'rank') q.set('sort', s.sort);
    var str = q.toString();
    return '#/board' + (str ? '?' + str : '');
  }
  function applyFilters(s) {
    var t = parseInt(s.tvl, 10);
    return rows.filter(function (r) {
      if (s.cat && r.category !== s.cat) return false;
      if (s.chain && r.chains.indexOf(s.chain) < 0) return false;
      if (s.wl && !r.watchlist) return false;
      if (t > 0 && r.tvl_usd < t) return false;
      if (t < 0 && r.tvl_usd >= -t) return false;
      if (s.q) {
        var q = s.q.toLowerCase();
        if ((r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function applySort(list, s) {
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd || a.rank - b.rank; },
      chg: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d) || a.rank - b.rank; },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days) || a.rank - b.rank; },
      mult: function (a, b) { return b.category_multiple - a.category_multiple || a.rank - b.rank; }
    };
    return list.slice().sort(by[s.sort] || by.rank);
  }
  function rowHtml(r) {
    return '<tr data-slug="' + esc(r.slug) + '"><td class="rank">#' + r.rank + '</td>' +
      '<td><span class="pname">' + esc(r.name) + '</span>' + (r.watchlist ? '<span class="wl">WATCHLIST</span>' : '') +
      '<br><span class="pslug">' + esc(r.slug) + '</span></td>' +
      '<td class="cat">' + esc(r.category || '—') + '</td>' +
      '<td class="chains">' + esc(r.chains[0] || '—') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') + '</td>' +
      '<td class="r num">' + fmt$(r.tvl_usd) + '</td>' +
      '<td class="r num ' + pctCls(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
      '<td class="r num">' + fmtAge(r.age_days) + '</td>' +
      '<td class="imp" style="' + heat(r.implied_value_usd) + '">' + fmt$(r.implied_value_usd) + '</td>' +
      '<td class="ratio">' + (r.implied_value_usd / r.tvl_usd).toFixed(2) + '×</td></tr>';
  }
  var SORTKEY = { 4: 'tvl', 5: 'chg', 6: 'age', 0: 'rank', 7: 'rank' };

  function renderBoard() {
    var s = stateFromHash();
    var opts = function (list, val, allLabel) {
      return (allLabel ? '<option value="">' + allLabel + '</option>' : '') + list.map(function (o) {
        var v = o.k != null ? o.k : o.v, t = o.k != null ? o.k + ' (' + o.n + ')' : o.t;
        return '<option value="' + esc(v) + '"' + (String(val) === String(v) ? ' selected' : '') + '>' + esc(t) + '</option>';
      }).join('');
    };
    view.innerHTML =
      '<div class="controls">' +
      '<input type="search" id="fq" placeholder="Search name, slug, category" value="' + esc(s.q) + '">' +
      '<select id="fcat">' + opts(CATS, s.cat, 'All categories') + '</select>' +
      '<select id="fchain">' + opts(CHAINS, s.chain, 'All chains') + '</select>' +
      '<select id="ftvl">' + opts(TVLS, s.tvl, null) + '</select>' +
      '<label class="chk"><input type="checkbox" id="fwl"' + (s.wl ? ' checked' : '') + '> watchlist only</label>' +
      '<select id="fsort">' + opts(SORTS, s.sort, null) + '</select>' +
      '<span class="count" id="fcount"></span></div>' +
      '<div class="panel" style="padding:6px 12px"><table><thead><tr>' +
      '<th data-i="0">#</th><th>Protocol</th><th>Category</th><th>Chains</th><th class="r" data-i="4">TVL</th>' +
      '<th class="r" data-i="5">7d</th><th class="r" data-i="6">Age</th><th class="r" data-i="7">Implied value</th>' +
      '<th class="r">impl ÷ TVL</th></tr></thead><tbody id="tbody"></tbody></table><div id="fempty"></div></div>' +
      '<p class="modelnote">Click a row for the protocol\'s factor breakdown and farm plan. ' +
      'Implied value cells are heat-shaded on a log scale across the board.</p>';

    var tbody = document.getElementById('tbody'), fcount = document.getElementById('fcount'),
        fempty = document.getElementById('fempty');
    function paint() {
      var list = applySort(applyFilters(s), s);
      tbody.innerHTML = list.map(rowHtml).join('');
      fempty.innerHTML = list.length ? '' : '<div class="empty">No protocol matches this filter. Loosen it — the radar keeps ' + rows.length + '.</div>';
      var active = s.q || s.cat || s.chain || s.wl || s.tvl !== '0';
      fcount.innerHTML = 'showing <b>' + list.length + '</b> of ' + rows.length + (active ? ' · filtered' : '');
      history.replaceState(null, '', hashOf(s));
    }
    function read() {
      s.q = document.getElementById('fq').value; s.cat = document.getElementById('fcat').value;
      s.chain = document.getElementById('fchain').value; s.tvl = document.getElementById('ftvl').value;
      s.wl = document.getElementById('fwl').checked; s.sort = document.getElementById('fsort').value;
    }
    ['fq', 'fcat', 'fchain', 'ftvl', 'fwl', 'fsort'].forEach(function (id) {
      var el = document.getElementById(id);
      el.addEventListener(id === 'fq' ? 'input' : 'change', function () { read(); paint(); });
    });
    view.querySelectorAll('thead th[data-i]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = SORTKEY[th.getAttribute('data-i')];
        if (k) { s.sort = k; document.getElementById('fsort').value = k; paint(); }
      });
    });
    tbody.addEventListener('click', function (ev) {
      var tr = ev.target.closest('tr[data-slug]');
      if (tr) location.hash = '#/p/' + tr.getAttribute('data-slug');
    });
    paint();
  }

  /* ---------- detail view ---------- */
  function splitStep(s) {
    var ci = s.indexOf(' Cost: ');
    if (ci < 0) return { text: s, cost: '', time: '' };
    var head = s.slice(0, ci), rest = s.slice(ci + 7), ti = rest.indexOf('. Time: ');
    if (ti < 0) return { text: head, cost: rest.replace(/\.$/, ''), time: '' };
    return { text: head, cost: rest.slice(0, ti), time: rest.slice(ti + 8).replace(/\.$/, '') };
  }
  function renderDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) { view.innerHTML = '<p class="empty">No protocol with that slug is on the board. <a href="#/board">Back to the board</a></p>'; return; }
    var m = multOf(r.category);
    var after1 = r.base_value_usd, after2 = after1 * r.growth_multiplier,
        after3 = after2 * r.maturity_multiplier, after4 = after3 * r.chain_multiplier;
    var vals = [r.tvl_usd, after1, after2, after3, r.implied_value_usd];
    var lo = Math.log10(Math.min.apply(null, vals)), hi = Math.log10(Math.max.apply(null, vals));
    function w(v) { return (hi === lo ? 100 : 8 + 92 * (Math.log10(v) - lo) / (hi - lo)).toFixed(1); }
    function wrow(label, val, final) {
      return '<div class="wrow' + (final ? ' final' : '') + '"><div class="wlab">' + label + '</div>' +
        '<div class="wbar"><div class="wfill" style="width:' + w(val) + '%"></div></div>' +
        '<div class="wval">' + fmt$(Math.round(val)) + '</div></div>';
    }
    var peers = rows.filter(function (x) { return x.category === r.category && x.slug !== r.slug; })
      .sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; }).slice(0, 5);
    view.innerHTML =
      '<a class="back" href="#/board">&larr; back to the board</a>' +
      '<div class="panel"><div class="dhead"><h2>' + esc(r.name) + '</h2>' +
      (r.watchlist ? '<span class="badge hot">ON THE WATCHLIST</span>' : '<span class="badge">EARLY FIND — BELOW THE $50M FLOOR</span>') +
      '<span class="badge">RANK #' + r.rank + ' OF ' + rows.length + '</span>' +
      '<span class="badge">' + esc(r.category || 'Uncategorised') + '</span></div>' +
      '<p class="dsub">' + esc(r.slug) + ' · records no token · tracked since ' + esc(r.listed_at || 'an unknown date') +
      ' · live on ' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ': ' + esc(r.chains.join(', ')) + '</p>' +
      '<div class="cards">' +
      '<div class="card"><div class="k">IMPLIED VALUE</div><div class="v">' + fmt$(r.implied_value_usd) + '</div><div class="s">the model\'s claim, below</div></div>' +
      '<div class="card"><div class="k">TVL</div><div class="v">' + fmt$(r.tvl_usd) + '</div><div class="s">7d ' + fmtPct(r.change_7d) + '</div></div>' +
      '<div class="card"><div class="k">IMPLIED ÷ TVL</div><div class="v">' + (r.implied_value_usd / r.tvl_usd).toFixed(2) + '×</div><div class="s">against a category median of ' + r.category_multiple.toFixed(2) + '×</div></div>' +
      '<div class="card"><div class="k">AGE WITH NO TOKEN</div><div class="v">' + fmtAge(r.age_days) + '</div><div class="s">' + (r.age_days == null ? 'listing date unknown' : r.age_days + ' days tracked') + '</div></div>' +
      '<div class="card"><div class="k">CATEGORY MULTIPLE</div><div class="v">' + r.category_multiple.toFixed(4) + '×</div><div class="s">' +
        (m ? (m.fallback ? 'global median — too few live samples' : 'median of ' + m.samples + ' live peers') : 'global median') + '</div></div>' +
      '</div>' +
      '<h3 class="sec">THE FACTOR BREAKDOWN — TVL IN, IMPLIED VALUE OUT</h3><div class="waterfall">' +
      wrow('TVL in the snapshot', r.tvl_usd, false) +
      wrow('× <b>' + r.category_multiple.toFixed(4) + '</b> category multiple → base', after1, false) +
      wrow('× <b>' + r.growth_multiplier.toFixed(4) + '</b> momentum (7d ' + fmtPct(r.growth_pct) + ', clamped)', after2, false) +
      wrow('× <b>' + r.maturity_multiplier.toFixed(4) + '</b> maturity (' + (r.age_days == null ? 'median age' : r.age_days + ' days') + ')', after3, false) +
      wrow('× <b>' + r.chain_multiplier.toFixed(2) + '</b> reach (' + r.chains.length + ' chains)', after4, false) +
      wrow('IMPLIED VALUE (rounded to $1K)', r.implied_value_usd, true) +
      '</div>' +
      '<h3 class="sec">HOW TO FARM IT — ' + r.farm_steps.length + ' STEPS, COSTS AND TIME INCLUDED</h3>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) {
        var p = splitStep(s);
        return '<li>' + esc(p.text) + '<div class="meta">' +
          (p.cost ? '<span>COST — ' + esc(p.cost) + '</span>' : '') +
          (p.time ? '<span class="time">TIME — ' + esc(p.time) + '</span>' : '') + '</div></li>';
      }).join('') + '</ol>' +
      (peers.length ? '<h3 class="sec">SAME CATEGORY, ALSO PRE-TOKEN</h3><table class="peers"><thead><tr><th>#</th><th>Protocol</th>' +
        '<th class="r">TVL</th><th class="r">Implied</th></tr></thead><tbody>' +
        peers.map(function (p) {
          return '<tr data-slug="' + esc(p.slug) + '"><td class="rank">#' + p.rank + '</td><td><span class="pname">' + esc(p.name) +
            '</span></td><td class="r num">' + fmt$(p.tvl_usd) + '</td><td class="r num">' + fmt$(p.implied_value_usd) + '</td></tr>';
        }).join('') + '</tbody></table>' : '') +
      '</div>';
    view.querySelectorAll('.peers tr[data-slug]').forEach(function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
    window.scrollTo(0, 0);
  }

  /* ---------- router ---------- */
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    var isDetail = h.indexOf('p/') === 0;
    /* The model banner and the live set belong to the board; a protocol's page stands alone. */
    document.getElementById('model').style.display = isDetail ? 'none' : '';
    document.getElementById('livewrap').style.display = isDetail ? 'none' : '';
    if (isDetail) renderDetail(decodeURIComponent(h.slice(2)));
    else renderBoard();
  }
  window.addEventListener('hashchange', route);
  route();
})();
