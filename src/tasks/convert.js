// Task family: convert — unit conversions with exact factors, minted per trial.
//
// A quantity in one unit is asked for in another (convert1), a rate in one pair of units in another
// pair (convert2), a three-step problem mixes units and ends in a whole number — a tank filled
// by a hose in US gallons per minute, a lift limit in kilograms against boxes in pounds, a trip in
// miles at a speed in km/h (convert3) — or the conversion is one the factor tool cannot do alone
// (convert4): a temperature *difference* (the affine conversion is wrong for it), a fuel figure
// that is a reciprocal (litres per 100 km against miles per gallon), a density whose volume unit
// the tool does not carry (the length factor has to be cubed), a cube's volume from its side. Two things can go wrong: the factor (is a US gallon 3.785
// litres or "about 4"?) and the arithmetic. The harness axis separates them: with tools the model
// gets `convert` (exact factors, affine for temperatures) and `calc`; without, it works from
// memory. Truth is exact from the factor table and the stated rounding rule, and the stated
// rounding is the answer: a value rounded the wrong way is wrong, a value given to more places
// than asked is accepted when it is the right number.

import { labelModel } from "../providers/index.js";
import { typos } from "../perturb.js";
import { dice, numberIn } from "./gen.js";
import { calcTool } from "../calc.js";

// ---- units: a base per dimension, exact factors, the names the problems and the tool use ------

const UNITS = {
  m: { dim: "length", f: 1, word: ["metre", "metres"], sym: "m", aliases: ["meter", "meters"] },
  cm: { dim: "length", f: 0.01, word: ["centimetre", "centimetres"], sym: "cm", aliases: ["centimeter", "centimeters"] },
  km: { dim: "length", f: 1000, word: ["kilometre", "kilometres"], sym: "km", aliases: ["kilometer", "kilometers"] },
  in: { dim: "length", f: 0.0254, word: ["inch", "inches"], sym: "in", aliases: ['"'] },
  ft: { dim: "length", f: 0.3048, word: ["foot", "feet"], sym: "ft", aliases: ["'"] },
  yd: { dim: "length", f: 0.9144, word: ["yard", "yards"], sym: "yd", aliases: [] },
  mi: { dim: "length", f: 1609.344, word: ["mile", "miles"], sym: "mi", aliases: [] },
  kg: { dim: "mass", f: 1, word: ["kilogram", "kilograms"], sym: "kg", aliases: ["kilo", "kilos"] },
  g: { dim: "mass", f: 0.001, word: ["gram", "grams"], sym: "g", aliases: ["gramme", "grammes"] },
  t: { dim: "mass", f: 1000, word: ["tonne", "tonnes"], sym: "t", aliases: ["metric ton", "metric tons"] },
  lb: { dim: "mass", f: 0.45359237, word: ["pound", "pounds"], sym: "lb", aliases: ["lbs"] },
  oz: { dim: "mass", f: 0.028349523125, word: ["ounce", "ounces"], sym: "oz", aliases: [] },
  L: { dim: "volume", f: 1, word: ["litre", "litres"], sym: "L", aliases: ["liter", "liters", "l"] },
  ml: { dim: "volume", f: 0.001, word: ["millilitre", "millilitres"], sym: "ml", aliases: ["milliliter", "milliliters", "cm3", "cm^3", "cm³", "cc", "cubic centimetre", "cubic centimetres", "cubic centimeter", "cubic centimeters"] },
  m3: { dim: "volume", f: 1000, word: ["cubic metre", "cubic metres"], sym: "m³", aliases: ["cubic meter", "cubic meters", "m^3", "m³"] },
  gal: { dim: "volume", f: 3.785411784, word: ["US gallon", "US gallons"], sym: "US gal", aliases: ["gallon", "gallons", "us gal", "usgal"] },
  qt: { dim: "volume", f: 0.946352946, word: ["US quart", "US quarts"], sym: "US qt", aliases: ["quart", "quarts"] },
  impgal: { dim: "volume", f: 4.54609, word: ["imperial gallon", "imperial gallons"], sym: "imp gal", aliases: ["imp gal", "uk gallon", "uk gallons", "imperial gal"] },
  s: { dim: "time", f: 1, word: ["second", "seconds"], sym: "s", aliases: ["sec", "secs"] },
  min: { dim: "time", f: 60, word: ["minute", "minutes"], sym: "min", aliases: ["mins"] },
  h: { dim: "time", f: 3600, word: ["hour", "hours"], sym: "h", aliases: ["hr", "hrs"] },
  day: { dim: "time", f: 86400, word: ["day", "days"], sym: "d", aliases: [] },
  mps: { dim: "speed", f: 1, word: ["metre per second", "metres per second"], sym: "m/s", aliases: ["m/s", "meters per second", "mps"] },
  kmh: { dim: "speed", f: 1000 / 3600, word: ["kilometre per hour", "kilometres per hour"], sym: "km/h", aliases: ["km/h", "kph", "kilometers per hour"] },
  mph: { dim: "speed", f: 0.44704, word: ["mile per hour", "miles per hour"], sym: "mph", aliases: ["mi/h"] },
  m2: { dim: "area", f: 1, word: ["square metre", "square metres"], sym: "m²", aliases: ["square meter", "square meters", "m^2", "m²", "sqm"] },
  ha: { dim: "area", f: 10000, word: ["hectare", "hectares"], sym: "ha", aliases: [] },
  acre: { dim: "area", f: 4046.8564224, word: ["acre", "acres"], sym: "ac", aliases: ["ac"] },
  ft2: { dim: "area", f: 0.09290304, word: ["square foot", "square feet"], sym: "ft²", aliases: ["sq ft", "sqft", "ft^2", "ft²"] },
  C: { dim: "temperature", word: ["degree Celsius", "degrees Celsius"], sym: "°C", aliases: ["celsius", "c", "°c", "centigrade"] },
  F: { dim: "temperature", word: ["degree Fahrenheit", "degrees Fahrenheit"], sym: "°F", aliases: ["fahrenheit", "f", "°f"] },
  K: { dim: "temperature", word: ["kelvin", "kelvin"], sym: "K", aliases: ["kelvins", "k"] },
};

const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
const LOOKUP = new Map();
for (const [key, u] of Object.entries(UNITS)) for (const name of [key, u.sym, ...u.word, ...u.aliases]) LOOKUP.set(norm(name), key);
export function unitOf(name) {
  const k = LOOKUP.get(norm(name)) ?? LOOKUP.get(norm(name).replace(/s$/, ""));
  return k ?? null;
}

// The conversion itself: linear through the base unit, affine for temperatures.
export function convert(value, from, to) {
  const a = unitOf(from), b = unitOf(to);
  if (!a) throw new Error(`unknown unit "${from}"`);
  if (!b) throw new Error(`unknown unit "${to}"`);
  if (UNITS[a].dim !== UNITS[b].dim) throw new Error(`cannot convert ${UNITS[a].dim} (${a}) to ${UNITS[b].dim} (${b})`);
  const v = Number(value);
  if (!Number.isFinite(v)) throw new Error(`value "${value}" is not a number`);
  if (UNITS[a].dim === "temperature") {
    const c = a === "C" ? v : a === "F" ? (v - 32) * 5 / 9 : v - 273.15;
    return b === "C" ? c : b === "F" ? c * 9 / 5 + 32 : c + 273.15;
  }
  return (v * UNITS[a].f) / UNITS[b].f;
}

export const convertTool = {
  name: "convert",
  description: "Convert a quantity between units with exact factors. Units: length m, cm, km, in, ft, yd, mi; mass kg, g, t, lb, oz; volume L, ml, m3, gal (US), qt (US), imp gal; time s, min, h, day; speed m/s, km/h, mph; area m2, ha, acre, ft2; temperature C, F, K. Returns { value, from, to, result }.",
  parameters: { type: "object", properties: { value: { type: "number" }, from: { type: "string", description: "The unit the value is in, e.g. \"lb\" or \"US gallons\"." }, to: { type: "string", description: "The unit wanted." } }, required: ["value", "from", "to"] },
  impl: async ({ value, from, to }) => ({ value: Number(value), from: unitOf(from) ?? from, to: unitOf(to) ?? to, result: convert(value, from, to) }),
};

// ---- rounding rules -----------------------------------------------------------------------------

const round = (x, decimals) => { const p = 10 ** decimals; return Math.round(x * p + (x >= 0 ? 1e-9 : -1e-9)) / p; };
export function applyRule(exact, rule) {
  if (rule.kind === "ceil") return Math.ceil(exact - 1e-9);
  if (rule.kind === "floor") return Math.floor(exact + 1e-9);
  return round(exact, rule.decimals);
}
const ruleText = (rule, unitWord) => (rule.kind === "ceil" ? "round up to the next whole number" : rule.kind === "floor" ? "round down to a whole number" : rule.decimals === 0 ? `to the nearest whole ${unitWord}` : rule.decimals === 1 ? "to one decimal place" : "to two decimal places");

// ---- the generator ------------------------------------------------------------------------------

const WORD = (key, n) => UNITS[key].word[n === 1 ? 0 : 1];
const SYM = (key) => UNITS[key].sym;
const fmt = (n) => String(Number(Number(n).toFixed(3)));

const L1 = [
  { kind: "mass", things: ["crate", "parcel", "engine block", "sack of rice", "anvil"], pairs: [["lb", "kg"], ["kg", "lb"], ["oz", "g"], ["t", "lb"]], range: [[8, 480], [3, 900], [4, 64], [1.2, 9.5]] },
  { kind: "length", things: ["trail", "bridge", "runway", "cable", "fence"], pairs: [["mi", "km"], ["km", "mi"], ["ft", "m"], ["in", "cm"], ["yd", "m"]], range: [[1.5, 42], [2, 120], [12, 900], [3, 96], [10, 400]] },
  { kind: "volume", things: ["tank", "barrel", "drum", "cistern", "vat"], pairs: [["gal", "L"], ["L", "gal"], ["m3", "gal"], ["impgal", "L"], ["qt", "ml"]], range: [[5, 400], [20, 1500], [1.2, 12], [4, 300], [1, 12]] },
  { kind: "temperature", things: [["oven", "kiln", "smoker"], ["sauna", "kiln", "drying room"], ["incubator", "greenhouse", "vivarium"]], pairs: [["F", "C"], ["C", "F"], ["C", "K"]], range: [[250, 480], [60, 260], [15, 45]] },
  { kind: "area", things: ["field", "vineyard", "orchard", "plot", "paddock"], pairs: [["acre", "ha"], ["ha", "acre"], ["ft2", "m2"]], range: [[3, 260], [2, 90], [400, 9000]] },
];
const L2 = [
  { kind: "flow", things: ["pump", "hose", "sprinkler line", "tap"], units: [["gal", "min", "L", "h"], ["L", "s", "gal", "min"], ["m3", "h", "L", "min"], ["impgal", "min", "L", "h"]], range: [[2, 40], [0.4, 6], [0.5, 30], [2, 40]] },
  { kind: "distance", things: [["train", "coach", "car"], ["delivery van", "tram", "bus"], ["cyclist", "runner", "rowing crew"], ["ferry", "lorry", "coach"]], units: [["mph", "h", "km"], ["kmh", "min", "mi"], ["mps", "min", "km"], ["kmh", "h", "mi"]], range: [[25, 95], [30, 130], [3, 12], [40, 110]] },
  { kind: "linear", things: ["rope", "chain", "cable", "steel bar"], units: [["lb", "ft", "kg", "m"], ["kg", "m", "lb", "ft"], ["oz", "yd", "g", "m"], ["g", "cm", "oz", "in"]], range: [[0.4, 9], [0.3, 12], [2, 40], [1, 30]] },
];
// Level 4: what the tool alone gets wrong. The table has no cubic foot, so a density has to go
// through the cubed length factor; a temperature difference goes through the ratio, not the
// affine conversion; litres per 100 km is a reciprocal of miles per gallon.
const L4 = [
  { kind: "tempdiff", things: ["kiln", "oven", "greenhouse", "cold store"], units: [["F", "C"], ["C", "F"]], range: [[18, 140], [8, 75]] },
  { kind: "economy", cars: ["car", "van", "taxi", "hatchback"], units: [["l100", "mpg"], ["mpg", "l100"]], range: [[4.5, 14], [18, 55]] },
  { kind: "density", things: ["timber", "granite", "concrete", "resin block"], units: [["lbft3", "kgm3"], ["kgm3", "lbft3"]], range: [[20, 180], [300, 2800]] },
  { kind: "cube", things: ["tank", "vat", "crate", "cistern"], units: [["m", "gal"], ["ft", "L"], ["cm", "ml"]], range: [[0.6, 2.4], [1.5, 6], [8, 40]] },
];
const L3 = [
  { kind: "fill", tanks: ["tank", "pool", "cistern", "reservoir"], hoses: ["hose", "pump", "feed line"], units: [["m3", "gal", "min", "min"], ["impgal", "L", "s", "min"], ["gal", "L", "min", "h"]], rangeV: [[1.2, 9], [400, 4000], [900, 9000]], rangeR: [[4, 30], [0.5, 4], [40, 400]] },
  { kind: "lift", boxes: ["box", "bag of cement", "drum", "pallet"], lifts: ["hoist", "forklift", "winch", "crane"], units: [["lb", "kg"], ["kg", "lb"], ["oz", "kg"]], rangeW: [[18, 140], [9, 60], [40, 900]], rangeL: [[300, 2400], [500, 3000], [3, 60]] },
  { kind: "trip", vehicles: [["coach", "lorry", "car"], ["van", "motorbike", "coach"], ["boat", "ferry", "barge"]], units: [["mi", "kmh", "min"], ["km", "mph", "min"], ["km", "mps", "h"]], rangeD: [[12, 220], [15, 300], [40, 400]], rangeS: [[30, 110], [20, 70], [4, 15]] },
  { kind: "fuel", cars: ["car", "van", "pickup", "taxi"], units: [["mi", "gal", "km", "L"]], rangeE: [[18, 52]], rangeD: [[60, 900]] },
];

const num = (d, [lo, hi], decimals) => { const p = 10 ** decimals; return Math.round((lo + d.rand() * (hi - lo)) * p) / p; };

// The exact value of an instance from its parts — the truth, and what a nudge recomputes.
export function exactOf(p) {
  switch (p.kind) {
    case "flow": return convert(p.a, p.vFrom, p.vTo) / convert(1, p.tFrom, p.tTo);
    case "distance": return convert(p.a, p.sFrom, "mps") * convert(p.t, p.tUnit, "s") / UNITS[p.dTo].f;
    case "linear": return convert(p.a, p.mFrom, p.mTo) / convert(1, p.lFrom, p.lTo);
    case "fill": return convert(p.V, p.vUnit, "L") / (convert(p.R, p.rUnit, "L") / convert(1, p.rTime, "s") * convert(1, p.outTime, "s"));
    case "lift": return convert(p.L, p.lUnit, "kg") / convert(p.w, p.wUnit, "kg");
    case "trip": return convert(p.D, p.dUnit, "m") / convert(p.S, p.sUnit, "mps") / convert(1, p.outTime, "s");
    case "fuel": return convert(p.D, "km", "mi") / p.E * convert(1, "gal", "L");
    // Level 4: the ratio of the scales, not the affine map; the reciprocal; the cubed length.
    case "tempdiff": return p.from === "F" ? p.a * 5 / 9 : p.a * 9 / 5;
    case "economy": return (100 * convert(1, "km", "mi")) / convert(1, "L", "gal") / p.a; // L/100 km ↔ mpg, both ways
    case "density": return p.from === "lbft3" ? p.a * UNITS.lb.f / UNITS.ft.f ** 3 : p.a * UNITS.ft.f ** 3 / UNITS.lb.f;
    case "cube": return convert(p.a ** 3, p.side === "m" ? "m3" : p.side === "cm" ? "ml" : "L", p.to) * (p.side === "ft" ? UNITS.ft.f ** 3 * 1000 : 1);
    default: return convert(p.a, p.from, p.to);
  }
}
const isHalf = (exact, rule) => rule.kind === "nearest" && Math.abs(exact * 10 ** rule.decimals - Math.round(exact * 10 ** rule.decimals)) === 0.5;
// The quantity a nudge moves, per kind — the main one the question is about.
const MAIN = { flow: "a", distance: "a", linear: "a", fill: "R", lift: "w", trip: "S", fuel: "D", tempdiff: "a", economy: "a", density: "a", cube: "a" };

export function generate(seed, level) {
  if (![1, 2, 3, 4].includes(level)) throw new Error(`convert: unknown level ${level}`);
  const d = dice(seed);
  for (let k = 0; k < 3; k++) d.rand(); // small seeds share their first draws; spread the kind choice
  let parts;
  if (level === 1) {
    const k = d.pick(L1);
    const i = d.int(0, k.pairs.length - 1);
    const [from, to] = k.pairs[i];
    const things = Array.isArray(k.things[0]) ? k.things[i] : k.things;
    const a = num(d, k.range[i], k.kind === "temperature" ? 0 : d.int(0, 1));
    const rule = { kind: "nearest", decimals: d.pick([0, 1, 2]) };
    parts = { kind: k.kind, thing: d.pick(things), a, from, to, rule };
  } else if (level === 2) {
    const k = d.pick(L2);
    const i = d.int(0, k.units.length - 1);
    // Small rates (pounds per foot) want two places; the large ones (litres per hour) none or one.
    const rule = { kind: "nearest", decimals: k.kind === "linear" ? 2 : d.pick([0, 1]) };
    const a = num(d, k.range[i], 1);
    if (k.kind === "flow") {
      const [vFrom, tFrom, vTo, tTo] = k.units[i];
      parts = { kind: k.kind, thing: d.pick(k.things), a, vFrom, tFrom, vTo, tTo, rule };
    } else if (k.kind === "distance") {
      const [sFrom, tUnit, dTo] = k.units[i];
      const t = num(d, tUnit === "h" ? [1.5, 9] : [8, 90], tUnit === "h" ? 1 : 0);
      parts = { kind: k.kind, thing: d.pick(k.things[i]), a, sFrom, t, tUnit, dTo, rule };
    } else {
      const [mFrom, lFrom, mTo, lTo] = k.units[i];
      parts = { kind: k.kind, thing: d.pick(k.things), a, mFrom, lFrom, mTo, lTo, rule };
    }
  } else if (level === 4) {
    const k = d.pick(L4);
    const i = d.int(0, k.units.length - 1);
    const [from, to] = k.units[i];
    const a = num(d, k.range[i], k.kind === "density" ? 0 : 1);
    if (k.kind === "tempdiff") parts = { kind: k.kind, thing: d.pick(k.things), a, from, to, rule: { kind: "nearest", decimals: 1 } };
    else if (k.kind === "economy") parts = { kind: k.kind, car: d.pick(k.cars), a, from, to, rule: { kind: "nearest", decimals: 1 } };
    else if (k.kind === "density") parts = { kind: k.kind, thing: d.pick(k.things), a, from, to, rule: { kind: "nearest", decimals: 0 } };
    else parts = { kind: k.kind, thing: d.pick(k.things), a, side: from, to, rule: { kind: "nearest", decimals: to === "ml" ? 0 : 0 } };
  } else {
    const k = d.pick(L3);
    const i = d.int(0, k.units.length - 1);
    if (k.kind === "fill") {
      const [vUnit, rUnit, rTime, outTime] = k.units[i];
      const V = num(d, k.rangeV[i], vUnit === "m3" ? 1 : 0), R = num(d, k.rangeR[i], 1);
      parts = { kind: k.kind, tank: d.pick(k.tanks), hose: d.pick(k.hoses), V, vUnit, R, rUnit, rTime, outTime, rule: { kind: "ceil" } };
    } else if (k.kind === "lift") {
      const [wUnit, lUnit] = k.units[i];
      const w = num(d, k.rangeW[i], 1), L = num(d, k.rangeL[i], 0);
      parts = { kind: k.kind, box: d.pick(k.boxes), lift: d.pick(k.lifts), w, wUnit, L, lUnit, rule: { kind: "floor" } };
    } else if (k.kind === "trip") {
      const [dUnit, sUnit, outTime] = k.units[i];
      const D = num(d, k.rangeD[i], 0), S = num(d, k.rangeS[i], 0);
      parts = { kind: k.kind, vehicle: d.pick(k.vehicles[i]), D, dUnit, S, sUnit, outTime, rule: { kind: "ceil" } };
    } else {
      const E = num(d, k.rangeE[0], 0), D = num(d, k.rangeD[0], 0);
      parts = { kind: k.kind, car: d.pick(k.cars), E, D, rule: { kind: "nearest", decimals: 1 } };
    }
  }
  // No exact halves under a nearest rule: nudge the main quantity until the value is not one.
  parts.exact = exactOf(parts);
  for (let guard = 0; guard < 20 && isHalf(parts.exact, parts.rule); guard++) {
    const key = MAIN[parts.kind] ?? "a";
    parts[key] = Number((parts[key] + 0.1).toFixed(2));
    parts.exact = exactOf(parts);
  }
  if (level === 1) parts.a = Number(parts.a.toFixed(2));
  const answer = applyRule(parts.exact, parts.rule);
  const { text, question } = render(parts, level);
  return { seed, level, parts, text, question, answer, exact: parts.exact, rule: parts.rule };
}

// ---- rendering: the base wording, an alternative, and a symbol form ----------------------------

const unitName = (key, n, form) => (form === "symbols" ? SYM(key) : WORD(key, n));
const per = (key, form) => (form === "symbols" ? `/${SYM(key)}` : ` per ${WORD(key, 1)}`);
const q = (n, key, form) => `${fmt(n)} ${unitName(key, n, form)}`;
const outUnit = (key, form) => (form === "symbols" ? SYM(key) : WORD(key, 2));
const rate = (n, top, bottom, form) => (form === "symbols" ? `${fmt(n)} ${SYM(top)}/${SYM(bottom)}` : `${fmt(n)} ${WORD(top, n)} per ${WORD(bottom, 1)}`);
const rateOut = (top, bottom, form) => (form === "symbols" ? `${SYM(top)}/${SYM(bottom)}` : `${WORD(top, 2)} per ${WORD(bottom, 1)}`);

export function render(p, level, { wording = "base", form = "words" } = {}) {
  const alt = wording === "alt";
  const rr = (unitKey) => ruleText(p.rule, WORD(unitKey, 1));
  if (level === 1) {
    const t = p.kind === "temperature";
    const text = t
      ? (alt ? `The ${p.thing} runs at ${q(p.a, p.from, form)}.` : `The ${p.thing} is set to ${q(p.a, p.from, form)}.`)
      : p.kind === "mass" ? (alt ? `A ${p.thing} comes in at ${q(p.a, p.from, form)} on the scale.` : `A ${p.thing} weighs ${q(p.a, p.from, form)}.`)
      : p.kind === "length" ? (alt ? `The ${p.thing} measures ${q(p.a, p.from, form)} end to end.` : `The ${p.thing} is ${q(p.a, p.from, form)} long.`)
      : p.kind === "volume" ? (alt ? `The ${p.thing} has a capacity of ${q(p.a, p.from, form)}.` : `The ${p.thing} holds ${q(p.a, p.from, form)}.`)
      : (alt ? `The ${p.thing} takes up ${q(p.a, p.from, form)}.` : `The ${p.thing} covers ${q(p.a, p.from, form)}.`);
    const question = alt ? `Express that in ${outUnit(p.to, form)}, ${rr(p.to)}.` : `What is that in ${outUnit(p.to, form)}, ${rr(p.to)}?`;
    return { text, question };
  }
  if (level === 2) {
    if (p.kind === "flow") return { text: alt ? `A ${p.thing} delivers ${rate(p.a, p.vFrom, p.tFrom, form)}.` : `A ${p.thing} moves ${rate(p.a, p.vFrom, p.tFrom, form)}.`, question: alt ? `Give that rate in ${rateOut(p.vTo, p.tTo, form)}, ${rr(p.vTo)}.` : `How many ${rateOut(p.vTo, p.tTo, form)} is that, ${rr(p.vTo)}?` };
    if (p.kind === "distance") return { text: alt ? `A ${p.thing} keeps a steady ${q(p.a, p.sFrom, form)}.` : `A ${p.thing} travels at ${q(p.a, p.sFrom, form)}.`, question: alt ? `In ${q(p.t, p.tUnit, form)} it covers what distance in ${outUnit(p.dTo, form)}, ${rr(p.dTo)}?` : `How far does it go in ${q(p.t, p.tUnit, form)}, in ${outUnit(p.dTo, form)}, ${rr(p.dTo)}?` };
    return { text: alt ? `A ${p.thing} has a linear weight of ${rate(p.a, p.mFrom, p.lFrom, form)}.` : `A ${p.thing} weighs ${rate(p.a, p.mFrom, p.lFrom, form)}.`, question: alt ? `Express that in ${rateOut(p.mTo, p.lTo, form)}, ${rr(p.mTo)}.` : `What is that in ${rateOut(p.mTo, p.lTo, form)}, ${rr(p.mTo)}?` };
  }
  if (p.kind === "tempdiff") {
    const unitWord = (k) => (form === "symbols" ? SYM(k) : `degrees ${k === "F" ? "Fahrenheit" : "Celsius"}`);
    return { text: alt ? `Over an hour the ${p.thing} warms by ${fmt(p.a)} ${unitWord(p.from)}.` : `The ${p.thing}'s temperature rises by ${fmt(p.a)} ${unitWord(p.from)} in an hour.`, question: alt ? `What is that rise in ${unitWord(p.to)}, to one decimal place?` : `By how many ${unitWord(p.to)} does it rise, to one decimal place?` };
  }
  if (p.kind === "economy") {
    const l100 = form === "symbols" ? "L/100 km" : "litres per 100 kilometres", mpg = form === "symbols" ? "mi per US gal" : "miles per US gallon";
    return p.from === "l100"
      ? { text: alt ? `A ${p.car} burns ${fmt(p.a)} ${l100}.` : `A ${p.car} uses ${fmt(p.a)} ${l100}.`, question: alt ? `Express its economy in ${mpg}, to one decimal place.` : `What is that in ${mpg}, to one decimal place?` }
      : { text: alt ? `A ${p.car} manages ${fmt(p.a)} ${mpg}.` : `A ${p.car} does ${fmt(p.a)} ${mpg}.`, question: alt ? `Express its consumption in ${l100}, to one decimal place.` : `What is that in ${l100}, to one decimal place?` };
  }
  if (p.kind === "density") {
    const lbft3 = form === "symbols" ? "lb/ft³" : "pounds per cubic foot", kgm3 = form === "symbols" ? "kg/m³" : "kilograms per cubic metre";
    const [fromW, toW] = p.from === "lbft3" ? [lbft3, kgm3] : [kgm3, lbft3];
    return { text: alt ? `The ${p.thing} has a density of ${fmt(p.a)} ${fromW}.` : `A ${p.thing} weighs ${fmt(p.a)} ${fromW}.`, question: alt ? `Express that density in ${toW}, to the nearest whole number.` : `What is that in ${toW}, to the nearest whole number?` };
  }
  if (p.kind === "cube") {
    const side = q(p.a, p.side, form);
    return { text: alt ? `A ${p.thing} is a perfect cube, ${side} along each edge.` : `A ${p.thing} is a cube ${side} on a side.`, question: alt ? `What is its capacity in ${outUnit(p.to, form)}, to the nearest whole number?` : `How much does it hold in ${outUnit(p.to, form)}, to the nearest whole number?` };
  }
  if (p.kind === "fill") return { text: alt ? `A ${p.tank} of ${q(p.V, p.vUnit, form)} is being filled by a ${p.hose} that supplies ${rate(p.R, p.rUnit, p.rTime, form)}.` : `A ${p.tank} holds ${q(p.V, p.vUnit, form)}. A ${p.hose} delivers ${rate(p.R, p.rUnit, p.rTime, form)}.`, question: alt ? `How many whole ${WORD(p.outTime, 2)} until it is full? Round up to the next whole number.` : `How many whole ${WORD(p.outTime, 2)} does it take to fill it? Round up to the next whole number.` };
  if (p.kind === "lift") return { text: alt ? `Every ${p.box} weighs ${q(p.w, p.wUnit, form)}, and the ${p.lift} is rated for ${q(p.L, p.lUnit, form)} at most.` : `Each ${p.box} weighs ${q(p.w, p.wUnit, form)}. A ${p.lift} can carry at most ${q(p.L, p.lUnit, form)}.`, question: alt ? `How many ${p.box}${p.box.endsWith("s") ? "" : "s"} can go up in one lift? Round down to a whole number.` : `How many of them can it carry at once? Round down to a whole number.` };
  if (p.kind === "trip") return { text: alt ? `A ${p.vehicle} has ${q(p.D, p.dUnit, form)} to cover and holds a steady ${q(p.S, p.sUnit, form)}.` : `A ${p.vehicle} covers ${q(p.D, p.dUnit, form)} at a steady ${q(p.S, p.sUnit, form)}.`, question: alt ? `How many whole ${WORD(p.outTime, 2)} is that? Round up to the next whole number.` : `How many whole ${WORD(p.outTime, 2)} does the trip take? Round up to the next whole number.` };
  return { text: alt ? `A ${p.car} manages ${fmt(p.E)} ${form === "symbols" ? "mi per US gal" : "miles per US gallon"}.` : `A ${p.car} does ${fmt(p.E)} ${form === "symbols" ? "mi per US gal" : "miles per US gallon"}.`, question: alt ? `Over ${q(p.D, "km", form)}, how many ${outUnit("L", form)} does it burn, to one decimal place?` : `How many ${outUnit("L", form)} does it use over ${q(p.D, "km", form)}, to one decimal place?` };
}

// ---- the treatments' hooks -----------------------------------------------------------------------

// The same problem in other words, in symbols, or with typos in the prose (the numbers and the
// unit words are never touched; the rounding rule is part of the question and stays).
export function perturb(ctx, kind, seed = 0) {
  if (!ctx?.parts) return null;
  if (kind === "paraphrase") { const r = render(ctx.parts, ctx.level, { wording: "alt" }); return { ...ctx, ...r, perturbed: kind }; }
  if (kind === "format") { const r = render(ctx.parts, ctx.level, { form: "symbols" }); return { ...ctx, ...r, perturbed: kind }; }
  if (kind === "typos") {
    // Every word of every unit name is protected ("degrees Fahrenheit" is two of them), as is the rule's vocabulary.
    const protect = Object.values(UNITS).flatMap((u) => [...u.word, ...u.aliases, u.sym]).flatMap((x) => x.split(/\s+/)).concat(["per", "whole", "decimal", "decimals", "nearest", "round", "up", "down", "place", "places"]);
    const text = typos(ctx.text, seed, { protect });
    const question = typos(ctx.question, (seed >>> 0) + 7919, { protect });
    return text === ctx.text && question === ctx.question ? null : { ...ctx, text, question, perturbed: kind };
  }
  return null;
}

// The same problem with the quantity gone ("A crate weighs some pounds"): nothing to convert.
export function unanswerable(ctx) {
  const p = ctx.parts;
  // The quantity that goes missing is the one the sentence states (fuel's is the miles per
  // gallon; the distance is in the question), wherever it stands.
  const key = ({ fuel: "E" })[p.kind] ?? MAIN[p.kind] ?? "a";
  const value = fmt(p[key]);
  const re = new RegExp(`\\b${value.replace(".", "\\.")}\\b`);
  const inText = re.test(ctx.text);
  const text = inText ? ctx.text.replace(re, "some") : ctx.text;
  const question = inText ? ctx.question : ctx.question.replace(re, "some");
  return { ...ctx, text, question, answer: null, unanswerable: true, missing: `the quantity (${value})` };
}

// ---- scoring ------------------------------------------------------------------------------------

const schema = {
  type: "object",
  properties: {
    work: { type: "array", items: { type: "string" }, description: "Your working — the factor used and each step — written before the answer." },
    answer: { type: "number", description: "The converted number, rounded as asked." },
  },
  required: ["answer"],
};
const answerOf = (out) => Number(out && typeof out === "object" ? (out.answer ?? out.result ?? out.value) : out);

// Right when it is the stated rounding of the exact value, or the exact value to more places than
// asked (a nearest-n-places rule only: "round up" and "round down" want the whole number).
export function judge(got, ground) {
  if (!Number.isFinite(got)) return { correct: false, reason: "no number in the answer" };
  const { answer, exact, rule } = ground;
  if (Math.abs(got - answer) < 1e-9) return { correct: true, reason: `answer ${got} is right` };
  if (rule.kind === "nearest" && Math.abs(got - exact) <= 0.5 * 10 ** -rule.decimals + 1e-9 && Math.abs(got - exact) < Math.abs(answer - exact) + 1e-9) return { correct: true, reason: `answer ${got} is the right value, given to more places than asked (${answer})` };
  const off = Math.abs(got - exact) / Math.max(Math.abs(exact), 1e-9);
  return { correct: false, reason: `answered ${got}, expected ${answer}${off < 0.03 ? " (off by less than 3 %: the factor or the rounding)" : off < 0.2 ? ` (off by ${(off * 100).toFixed(0)} %)` : ""}` };
}

function makeConvert(level) {
  const problem = (ctx) => `${ctx.text} ${ctx.question}`;
  const tools = level === 1 ? [convertTool] : [convertTool, calcTool];
  const toolNote = level === 1 ? "Use the convert tool for the factor." : "Use the convert tool for every factor and calc for the arithmetic — never do either in your head.";
  return {
    name: `convert${level}`,
    family: "convert",
    level,
    category: "reasoning",
    seeded: true,
    capabilities: ["arithmetic", "unit-conversion"],
    description: level === 1
      ? "One quantity in another unit (mass, length, volume, area, temperature) with a stated rounding, minted per trial; the factor is the knowledge. With tools, an exact converter."
      : level === 2
        ? "A rate in another pair of units — US gallons per minute in litres per hour, pounds per foot in kilograms per metre, a speed over a time as a distance — with a stated rounding. With tools, an exact converter and a calculator."
        : level === 3
          ? "Three steps ending in a whole number: a tank filled by a hose in other units, a lift limit against boxes in pounds, a trip in miles at a speed in km/h, fuel over kilometres at miles per gallon. With tools, an exact converter and a calculator."
          : "What the converter cannot do alone: a temperature difference (the affine conversion is wrong for it), litres per 100 km against miles per gallon (a reciprocal), a density whose cubic foot the tool lacks (the length factor cubed), a cube's capacity from its side. With tools, the converter and a calculator — and the understanding of when not to trust the first.",
    model: labelModel,
    maxRounds: level + 4,

    setup: async ({ seed }) => generate(seed >>> 0, level),
    unanswerable,
    perturb,
    perturbs: ["paraphrase", "format", "typos"],

    goal: (ctx) => `${problem(ctx)} Give the number.`,

    noHarness: {
      prompt: (ctx) => `${problem(ctx)} Work it out and finish with a line of the form "answer: <number>".`,
      extract: "text",
    },
    harness: {
      system: `You are a careful engineer. ${toolNote} Return the requested JSON.`,
      prompt: (ctx) => `${problem(ctx)} ${toolNote} Then answer with a JSON object { "work": ["<step>", …], "answer": <number> } — the working first, then the answer.`,
      tools,
      schema,
      extract: "structured",
    },
    schemaOnly: {
      system: "You are a careful engineer. Return the requested JSON.",
      prompt: (ctx) => `${problem(ctx)} Answer with a JSON object { "work": ["<step>", …], "answer": <number> } — write the factor you use and each step in "work" first, then the answer.`,
      tools: [],
      schema,
      extract: "structured",
    },
    toolOnly: {
      system: `You are a careful engineer. ${toolNote}`,
      prompt: (ctx) => `${problem(ctx)} ${toolNote} Then finish with a line of the form "answer: <number>".`,
      tools,
      extract: "text",
    },

    eval: {
      ground: ({ ctx } = {}) => (ctx ? { answer: ctx.answer, exact: ctx.exact, rule: ctx.rule } : null),
      toolUse: ({ toolCalls, toolResults, ctx }) => {
        const conv = toolCalls.filter((c) => c.name === "convert");
        if (ctx?.unanswerable) return { ok: true, reason: conv.length ? `${conv.length} convert call(s) on a problem with the quantity missing` : "nothing to convert: the quantity was missing" };
        if (!conv.length) return { ok: false, reason: "convert was never called — the factor came from memory" };
        const failed = toolResults.filter((r) => r.name === "convert" && r.ok === false).length;
        if (failed === conv.length) return { ok: false, reason: `none of the ${conv.length} convert call(s) succeeded (unknown units?)` };
        const calcs = toolCalls.filter((c) => c.name === "calc").length;
        if (level >= 3 && !calcs) return { ok: false, reason: `convert called ${conv.length} time(s), but the arithmetic was done in the head (calc never called)` };
        return { ok: true, reason: `convert called ${conv.length} time(s)${failed ? `, ${failed} failed` : ""}${calcs ? `, calc ${calcs}` : ""}` };
      },
      scoreHarness: (out, ground) => (out === null || out === undefined ? { correct: false, reason: "no structured output" } : judge(answerOf(out), ground)),
      scoreNoHarness: (out, ground) => judge(numberIn(out), ground),
      canon: (answer, { structured }) => {
        const n = structured ? answerOf(answer) : numberIn(answer);
        return Number.isFinite(n) ? String(n) : "none";
      },
    },
  };
}

export const convertTasks = [1, 2, 3, 4].map(makeConvert);
export { schema, makeConvert, UNITS };
