/**
 * Trait rarity scoring.
 *
 * Each token's traits are compared with how often each trait value occurs in the
 * collection. Two standard scores are computed:
 *  - information content (IC): sum of -log2(frequency). The primary ranking; it
 *    behaves well when collections have many traits.
 *  - rarity score: sum of 1/frequency (the rarity.tools method). Used to break ties.
 * A token missing a trait gets the value "(none)" for it, and the number of traits
 * a token has is itself scored, as rarity sites do.
 *
 * When frequencies come from a sample of the collection (big supplies), add-one
 * smoothing keeps a value seen once in the sample from being treated as unique.
 */

export interface Trait {
  type: string;
  value: string;
}

export interface TokenTraits {
  id: string;
  traits: Trait[];
}

export interface Scored {
  id: string;
  ic: number;
  score: number;
  /** 0 = rarest token in the scored set, 1 = most common. */
  percentile: number;
  rank: number;
}

const NONE = "(none)";
const COUNT = "(trait count)";

/** Pulls traits out of the common metadata shapes; returns null if there are none. */
export function extractTraits(meta: unknown): Trait[] | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const raw = m.attributes ?? m.traits ?? m.properties;
  const out: Trait[] = [];
  if (Array.isArray(raw)) {
    for (const a of raw) {
      if (!a || typeof a !== "object") continue;
      const t = a as Record<string, unknown>;
      const type = t.trait_type ?? t.type ?? t.name ?? t.key;
      const value = t.value;
      if (type === undefined || value === undefined || value === null || typeof value === "object") continue;
      // Numeric "stats"/"boost" display types are levels, not rarity traits.
      if (typeof t.display_type === "string" && t.display_type !== "string") continue;
      out.push({ type: String(type).trim().toLowerCase(), value: String(value).trim().toLowerCase() });
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined || typeof v === "object") continue;
      out.push({ type: k.trim().toLowerCase(), value: String(v).trim().toLowerCase() });
    }
  }
  // An explicit "none" value is kept; scoring treats it the same as a missing trait.
  const kept = out.filter((t) => t.value !== "");
  return kept.length ? kept : null;
}

/**
 * Scores every token in `tokens` against frequencies computed from `tokens`.
 * `populationSize` (the collection's supply) enables smoothing when `tokens` is a sample.
 */
export function scoreCollection(tokens: TokenTraits[], populationSize?: number): Scored[] {
  const n = tokens.length;
  if (n === 0) return [];
  const sampled = populationSize !== undefined && populationSize > n;

  const types = new Set<string>();
  for (const t of tokens) for (const tr of t.traits) if (tr.value !== "none") types.add(tr.type);

  const valuesOf = (t: TokenTraits): Map<string, string> => {
    const m = new Map<string, string>();
    for (const tr of t.traits) if (tr.value !== "none") m.set(tr.type, tr.value);
    for (const ty of types) if (!m.has(ty)) m.set(ty, NONE);
    m.set(COUNT, String([...m.values()].filter((v) => v !== NONE).length));
    return m;
  };

  const perToken = tokens.map(valuesOf);
  const counts = new Map<string, Map<string, number>>();
  for (const m of perToken) {
    for (const [ty, v] of m) {
      let c = counts.get(ty);
      if (!c) counts.set(ty, (c = new Map()));
      c.set(v, (c.get(v) ?? 0) + 1);
    }
  }

  const freq = (ty: string, v: string): number => {
    const c = counts.get(ty)!;
    const k = c.get(v) ?? 0;
    return sampled ? (k + 1) / (n + c.size + 1) : k / n;
  };

  const raw = tokens.map((t, i) => {
    let ic = 0;
    let score = 0;
    for (const [ty, v] of perToken[i]) {
      const f = freq(ty, v);
      ic += -Math.log2(f);
      score += 1 / f;
    }
    return { id: t.id, ic, score };
  });

  const sorted = [...raw].sort((a, b) => b.ic - a.ic || b.score - a.score || compareIds(a.id, b.id));
  const out = new Map<string, Scored>();
  const same = (a: { ic: number; score: number }, b: { ic: number; score: number }) =>
    Math.abs(a.ic - b.ic) < 1e-9 && Math.abs(a.score - b.score) < 1e-9;
  // Tokens with identical scores share one rank, and one percentile at the middle of the
  // tied group. (Using the start of the group would make the most common tokens, which
  // usually form one huge tie at the bottom, look better than the median.)
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && same(sorted[i], sorted[j + 1])) j++;
    const percentile = n === 1 ? 0 : (i + (j - i) / 2) / n;
    for (let k = i; k <= j; k++) out.set(sorted[k].id, { ...sorted[k], rank: i + 1, percentile });
    i = j + 1;
  }
  return tokens.map((t) => out.get(t.id)!);
}

/** True when scores carry no information: every token has the same traits. */
export function hasRaritySignal(scored: Scored[]): boolean {
  if (scored.length < 2) return false;
  const first = scored[0].ic;
  return scored.some((s) => Math.abs(s.ic - first) > 1e-9);
}

function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
