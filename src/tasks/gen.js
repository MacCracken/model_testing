// gen.js — what generated task families share: a seeded RNG, a per-trial seed derivation and a
// tolerant number reader.
//
// A generated family mints a fresh instance per trial from a seed, so nothing it asks can have
// leaked into a training set we do not control, and the same instance can be re-minted for a paired
// comparison (same seed → same problem for every mode, client and later checkpoint).

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const ch of String(str)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// mulberry32 — small, deterministic, good enough for minting problems.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The seed for one trial: the run's instance seed, the task and the trial index — never the mode or
// the client, so every mode and client in a run sees the same instance (a paired design).
export function seedFor(instanceSeed, taskName, index) {
  return fnv1a(`${(Number(instanceSeed) >>> 0)}:${taskName}:${index}`);
}

export function dice(seed) {
  const rand = rng(seed);
  return {
    rand,
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    shuffle: (arr) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    chance: (p) => rand() < p,
  };
}

// "answer: 42" wins; otherwise the last number in the text. Thousands separators are tolerated.
export function numberIn(text) {
  const t = String(text ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const m = t.match(/answer\s*[:=]?\s*\**\s*(-?\d+(?:\.\d+)?)/i);
  if (m) return Number(m[1]);
  const all = t.match(/-?\d+(?:\.\d+)?/g);
  return all ? Number(all[all.length - 1]) : NaN;
}

// "answer: dog" wins; otherwise the last of the candidate words that appears in the text.
export function wordIn(text, candidates) {
  const t = String(text ?? "").toLowerCase();
  const m = t.match(/answer\s*[:=]?\s*\**\s*([a-z][a-z\- ]*)/i);
  if (m) {
    const said = m[1].trim();
    const hit = candidates.find((c) => said.startsWith(c.toLowerCase()));
    if (hit) return hit;
  }
  let best = null;
  let at = -1;
  for (const c of candidates) {
    const i = t.lastIndexOf(c.toLowerCase());
    if (i > at) { at = i; best = c; }
  }
  return best;
}
