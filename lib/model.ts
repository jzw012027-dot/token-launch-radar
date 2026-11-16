// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// THE MODEL (published in full on the dashboard; every figure below is computed from the
// snapshot itself, never from a hand-written list of names):
//
//   1. Category multiples. Among the snapshot's live-token protocols that report both a
//      market cap and a TVL (128 of them in the sealed snapshot, counting only mcap > 0:
//      a reported zero testifies nothing), take ratio = mcap / TVL,
//      group by category and use each category's MEDIAN ratio as the multiple a pre-token
//      protocol of that category would trade at. Categories with fewer than 5 samples fall
//      back to the global median (0.2138 in this snapshot). The used multiple is clamped to
//      [0.05, 3] so one wild category cannot dominate the board.
//        base = tvl_usd x category_multiple
//   2. Momentum. growth = clamp(change_7d, -50, +100) per cent (the snapshot's wildest
//      print is +4448%; the clamp eats it), growthMult = 1 + 0.35 x growth / 100.
//   3. Maturity. age = days from listed_at to the snapshot's as_of; a protocol that has run
//      longer with no token has had longer to accumulate value:
//        maturityMult = 0.75 + 0.45 x min(age, 1460) / 1460
//      (unknown listed_at: the snapshot's median age).
//   4. Multi-chain reach. chainMult = 1 + 0.03 x min(chains - 1, 5).
//   5. implied = round(base x growthMult x maturityMult x chainMult) to the nearest $1,000,
//      floored at $1,000,000. Ranks sort by implied, then TVL, then slug: a total order, so
//      two runs of this program print byte-identical output.
//
// WHO IS RANKED. A protocol is pre-token when its record carries no token: gecko_id and
// symbol both null (342 of 758). The watchlist's 40 slugs are always ranked. Every other
// candidate must pass the house's own derivative screen, generalised from the watchlist
// rule to the whole snapshot: category not in {Bridge, Canonical Bridge, Liquid Staking,
// Liquid Restaking, Restaked BTC, CEX}; no whole word wrapped / staked / staking in the
// name; the name does not begin with an exchange's name; and a name ending in a version
// marker (V2, v2, 2.0 ...) is an older release of the same protocol, so only the largest
// TVL of each name family is kept. What survives is the board: 208 rows in this snapshot.
//
// A protocol's record is DefiLlama's, not proof: rows say a protocol RECORDS no token,
// never that it has none, and an implied value is this model's claim, not a prediction.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  min_category_samples: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  chain_step: number;
  chain_max_extra: number;
  implied_floor_usd: number;
  implied_round_usd: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.05,
  multiple_cap: 3,
  min_category_samples: 5,
  growth_weight: 0.35,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.75,
  maturity_range: 0.45,
  maturity_days: 1460,
  chain_step: 0.03,
  chain_max_extra: 5,
  implied_floor_usd: 1_000_000,
  implied_round_usd: 1_000,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2-catmed';

/** One category's multiple: the median mcap/TVL of its live-token protocols. */
export interface CategoryMultiple {
  category: string;
  samples: number;
  median_multiple: number;
  multiple: number;
  fallback: boolean;
}

/** Everything the model learns from the snapshot before it scores a single row. */
export interface ModelStats {
  /** Live-token protocols carrying both a market cap and a TVL: the multiples' sample. */
  sample_size: number;
  global_multiple: number;
  multiples: CategoryMultiple[];
  /** Median protocol age in days, for rows whose listed_at is unknown. */
  median_age_days: number;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, computed on a sorted copy. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const UNCATEGORISED = 'Uncategorised';

function categoryKey(p: SnapshotProtocol): string {
  return p.category ?? UNCATEGORISED;
}

/**
 * The multiples table: for every category, the median mcap/TVL of the snapshot's live-token
 * protocols in it. Only protocols reporting both figures can testify (mcap_usd > 0, tvl > 0).
 * Categories under the sample floor fall back to the global median; every used multiple is
 * clamped to the model's [floor, cap].
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): ModelStats {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    const key = categoryKey(p);
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  const globalMedian = allRatios.length > 0 ? median(allRatios) : 0;
  const clampMultiple = (n: number): number => Math.min(model.multiple_cap, Math.max(model.multiple_floor, n));
  const multiples: CategoryMultiple[] = [...ratiosByCategory.keys()].sort().map((category) => {
    const samples = ratiosByCategory.get(category)!;
    const med = median(samples);
    const fallback = samples.length < model.min_category_samples;
    return {
      category,
      samples: samples.length,
      median_multiple: round4(med),
      multiple: round4(clampMultiple(fallback ? globalMedian : med)),
      fallback,
    };
  });
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return {
    sample_size: allRatios.length,
    global_multiple: round4(clampMultiple(globalMedian)),
    multiples,
    median_age_days: ages.length > 0 ? Math.round(median(ages)) : 365,
  };
}

/** The multiple one protocol is scored with, and whether it is its category's own or the fallback. */
function multipleFor(stats: ModelStats, p: SnapshotProtocol): { multiple: number; fallback: boolean } {
  const entry = stats.multiples.find((m) => m.category === categoryKey(p));
  if (entry === undefined) return { multiple: stats.global_multiple, fallback: true };
  return { multiple: entry.multiple, fallback: entry.fallback };
}

/** The factor decomposition of one protocol's implied value: every multiplier, stated. */
export interface FactorBreakdown {
  category_multiple: number;
  multiple_fallback: boolean;
  base_value_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  age_days: number | null;
}

/** Score one protocol: base from its category multiple, then momentum, maturity and reach. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  stats: ModelStats,
  model: ModelConstants = MODEL,
): { implied: number; factors: FactorBreakdown } {
  const { multiple, fallback } = multipleFor(stats, protocol);
  const base = protocol.tvl_usd * multiple;
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const age = ageDays(asOf, protocol.listed_at);
  const ageForModel = age ?? stats.median_age_days;
  const maturityMult =
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainMult = 1 + model.chain_step * Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max_extra);
  const raw = base * growthMult * maturityMult * chainMult;
  const rounded = Math.round(raw / model.implied_round_usd) * model.implied_round_usd;
  const implied = Math.min(100_000_000_000_000, Math.max(model.implied_floor_usd, rounded));
  return {
    implied,
    factors: {
      category_multiple: multiple,
      multiple_fallback: fallback,
      base_value_usd: Math.round(base),
      growth_pct: round4(growthPct),
      growth_multiplier: round4(growthMult),
      maturity_multiplier: round4(maturityMult),
      chain_multiplier: round4(chainMult),
      age_days: age,
    },
  };
}

/** Whether a protocol records no token at all: no CoinGecko id and no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Categories whose products are a wrapped or staked claim on another protocol's asset. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word wrapped, staked or staking anywhere in the name, any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that begin with an exchange's name are the exchange's own product, not a launch candidate. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** DefiLlama's version-marker rule: a name ending in a release is an older version of a protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Why a pre-token protocol is a derivative of something else, or null when it stands on its own. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category} is a wrapped or staked product`;
  if (WRAPPED_WORD.test(p.name)) return 'name carries wrapped, staked or staking';
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return 'name begins with an exchange name';
  return null;
}

/** The name family a protocol belongs to: its name with any version marker stripped. */
function nameFamily(p: SnapshotProtocol): string {
  return p.name.replace(VERSIONED, '').trim().toLowerCase();
}

/**
 * The non-watchlist candidates that survive the derivative screen, with each version family
 * reduced to its largest-TVL member: an old release never takes a second seat on the board.
 */
export function earlyCandidates(snapshot: Snapshot, chosen: ReadonlySet<string>): SnapshotProtocol[] {
  const survivors = snapshot.protocols.filter((p) => isPreToken(p) && !chosen.has(p.slug) && exclusionReason(p) === null);
  const byFamily = new Map<string, SnapshotProtocol>();
  for (const p of survivors) {
    const family = nameFamily(p);
    const current = byFamily.get(family);
    if (current === undefined || p.tvl_usd > current.tvl_usd || (p.tvl_usd === current.tvl_usd && p.slug < current.slug)) {
      byFamily.set(family, p);
    }
  }
  return [...byFamily.values()];
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: FactorBreakdown;
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  category_multiple: number;
  base_value_usd: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  mcap_tvl: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  stats: ModelStats;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, by the chain's fee tier: the farm plan's gas figures. */
interface ChainTier {
  label: string;
  perTx: string;
  weekly: string;
}

const LOW_FEE_CHAINS = new Set([
  'Base', 'Arbitrum', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast',
  'Mode', 'Taiko', 'BSC', 'Avalanche', 'Fantom', 'Gnosis', 'Celo', 'Moonbeam', 'Aurora', 'Metis',
  'Boba', 'Near', 'Aptos', 'Sui', 'Sei', 'Starknet', 'Manta', 'Zora', 'Fraxtal', 'Sonic', 'Berachain',
]);

function chainTier(chain: string): ChainTier {
  if (chain === 'Ethereum') return { label: 'high-fee mainnet', perTx: '$8 to $25 of gas per transaction', weekly: 'about $10 of gas a week' };
  if (chain === 'Solana') return { label: 'very-low-fee', perTx: 'under $0.05 of gas per transaction', weekly: 'under $0.25 of gas a week' };
  if (LOW_FEE_CHAINS.has(chain)) return { label: 'low-fee', perTx: '$0.05 to $1 of gas per transaction', weekly: 'about $0.50 of gas a week' };
  return { label: 'mid-fee', perTx: '$1 to $5 of gas per transaction', weekly: 'about $3 of gas a week' };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 1000;
  if (p.tvl_usd >= 1_000_000_000) return 500;
  if (p.tvl_usd >= 100_000_000) return 250;
  if (p.tvl_usd >= 50_000_000) return 150;
  return 100;
}

/** How many weeks to stay active, from the protocol's age: younger protocols get a longer window. */
function holdWeeksFor(age: number | null): number {
  if (age === null) return 8;
  if (age < 180) return 12;
  if (age < 365) return 10;
  if (age < 730) return 8;
  return 6;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow about 40% against it and re-supply the borrow once, keeping the health factor above 2.`;
  if (c.includes('dex'))
    return `Provide $${capital} split evenly between USDC and ETH in ${name}'s main pool on ${chain} and keep the LP position open.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position each week, sized under 10% of the margin.`;
  if (c.includes('leveraged farm'))
    return `Open a $${capital} leveraged farming position in ${name} on ${chain} at the lowest leverage tier and keep it open.`;
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('curator'))
    return `Deposit $${capital} into the largest curated vault ${name} runs on ${chain} and keep the vault shares.`;
  if (c.includes('yield'))
    return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the vault shares.`;
  if (c.includes('rwa'))
    return `Subscribe $${capital} to ${name}'s yield product on ${chain} after its onboarding checks, and hold the position.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the same wallet.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy until it expires.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and hold one position in its most liquid market at a time.`;
  if (c.includes('launchpad'))
    return `Register on ${name} with $${capital} ready and take part in one offering on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name}'s core product on ${chain} and keep the position open.`;
}

/** The weekly qualifying action, flavoured by category. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp')) return 'a small top-up, a partial borrow or a repay';
  if (c.includes('dex')) return 'one swap and a check that the LP range still holds';
  if (c.includes('perpetual') || c.includes('derivative')) return 'one small hedged trade';
  if (c.includes('bridge')) return 'one small bridge transfer';
  return 'one deposit, one withdrawal-and-return, or one vote';
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters once trimmed. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.trim().length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: five steps, each an action with a cost and a time. The plan is
 * generated from the protocol's own record (category template x main chain's fee tier,
 * capital from its TVL, holding window from its age, pace from its 7-day TVL change) —
 * no protocol name is ever special-cased.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const tier = chainTier(chain);
  const capital = capitalFor(p);
  const weeks = holdWeeksFor(age);
  const growth = Math.round(finite(p.change_7d, 0));
  const pace =
    growth >= 20
      ? `${p.name}'s TVL grew ${growth}% in the last 7 days, so start this week while the momentum is live`
      : growth <= -20
        ? `${p.name}'s TVL fell ${Math.abs(growth)}% in the last 7 days, so size the position at half and re-check in a week`
        : `${p.name}'s TVL moved ${growth}% in the last 7 days, a normal pace, so start any time this month`;
  return [
    {
      text: `Open a fresh wallet for this farm and fund it on ${chain} (${tier.label}) with the position capital plus a gas buffer.`,
      cost: `${tier.perTx}, about $5 to $30 total to set up depending on the chain`,
      time: '20 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and ${tier.perTx}`,
      time: '30 minutes to set up',
    },
    {
      text: `Stay active for at least ${weeks} weeks: make one qualifying action every week, such as ${weeklyFor(p)}, so the wallet appears in more than one weekly snapshot.`,
      cost: tier.weekly,
      time: `${weeks} weeks, about 10 minutes a week`,
    },
    {
      text: `Join ${p.name}'s points, rewards or quest program if one is live, finish its starter tasks, and keep screenshots of every balance the program shows.`,
      cost: 'no fee beyond the gas already counted; never pay a third party to join',
      time: '1 hour in the first week, then 5 minutes a week',
    },
    {
      text: `${pace}. If a token launches, claim only from the link on ${p.name}'s own page and never pay a fee to claim; log the wallet, dates and transactions so the position can be repeated or unwound.`,
      cost: 'nothing to check; a claim never costs a fee',
      time: '10 minutes',
    },
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const stats = categoryMultiples(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug, ranked whatever the derivative screen says.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of earlyCandidates(snapshot, new Set(chosen.keys()))) chosen.set(p.slug, p);

  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => {
    const { implied, factors } = impliedValue(p, snapshot.as_of, stats, model);
    return { p, implied, factors };
  });
  // A total order — implied, then TVL, then slug — so two runs print identical bytes.
  scored.sort(
    (a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    watchlist: watchlist.has(s.p.slug),
    age_days: s.factors.age_days,
    implied_value_usd: s.implied,
    model: s.factors,
    farm_steps: farmSteps(s.p, s.factors.age_days).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    watchlist: row.watchlist,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    base_value_usd: row.model.base_value_usd,
    growth_pct: row.model.growth_pct,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    stats: categoryMultiples(snapshot, model),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside the gate's 100 to 4,000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.name.trim().length === 0) return `${r.slug} has an empty name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters once trimmed`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
