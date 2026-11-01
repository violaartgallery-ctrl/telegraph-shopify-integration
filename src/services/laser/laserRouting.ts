/**
 * Which laser file each line item feeds (port of ai_writer.py's piece routing).
 * Products are matched to the store's own families (violaleather.com titles; a
 * bundle by its first piece). A bundle is ONE line item whose fields belong to
 * several pieces: each file takes only the fields labelled for it.
 */
export interface LaserPhoto {
  position_label?: string | null;
  display_label?: string;
  order_name?: string;
  attachment_url?: string;
}
export interface LaserEntry {
  display_product: string;
  display_color?: string;
  color?: string;
  total_quantity?: number;
  customization_cleaned: Array<[string, string]>;
  photo_numbers?: LaserPhoto[];
  source_orders?: Array<{ order_name?: string; remaining_quantity?: number }>;
}
export type Piece = "box" | "purse_box" | "keychain" | "wallet" | "purse" | "passport" | "bag_tag";

// Only these are made on the factory's wallet / purse templates: the ready-made
// Easy Carry, Flip Bifold, Full Carry, Twin Pocket, Slim Money Clip and Magic
// wallets are other products with no laser template.
const WALLET_FAMILIES = new Set(["wallet", "lines wallet", "decorated wallet", "wallet with transparent pocket",
  "lines wallet with transparent pocket", "decorated wallet with transparent pocket"]);
const PURSE_FAMILIES = new Set(["purse", "mandela purse", "mandala purse"]);
const BODY_PIECES: Piece[] = ["wallet", "purse", "passport"];
const BOX_PIECES: Piece[] = ["box", "purse_box"];
/** Pieces with a laser file. A bag tag (alone or in The Leather Travel Set) has none yet. */
export const LASER_PIECES: Piece[] = ["box", "purse_box", "keychain", "wallet", "purse", "passport"];

const title = (e: LaserEntry) => e.display_product || "";
export const entryColor = (e: LaserEntry) => e.color || e.display_color || "";

/** 'Lines wallet + Photo keychain + Gift box bundle' -> 'lines wallet'. */
export function family(e: LaserEntry): string {
  const p = title(e).toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return p.split(/ \+ | photo keychain| gift (?:purse )?box| bundle/)[0]!.trim();
}
export function isWallet(e: LaserEntry): boolean {
  return WALLET_FAMILIES.has(family(e)) || title(e).includes("محفظة") || title(e).includes("محفظه");
}
/** Custom / Decorated Passport holder, and The Leather Travel Set (passport + bag tag). */
export function isPassport(e: LaserEntry): boolean {
  const p = title(e).toLowerCase();
  return p.includes("passport") || p.includes("travel set") || p.includes("باسبور") || p.includes("جواز");
}
export function isPurse(e: LaserEntry): boolean {
  return PURSE_FAMILIES.has(family(e)) || title(e).includes("بورتفيه");
}
export function isBagTag(e: LaserEntry): boolean {
  const p = title(e).toLowerCase();
  return p.includes("bag tag") || p.includes("travel set");
}
export function isKeychain(e: LaserEntry): boolean {
  const p = title(e).toLowerCase();
  return ["keychain", "key chain", "ميدالية", "ميداليه"].some((k) => p.includes(k));
}
export function isBox(e: LaserEntry): boolean {
  const p = title(e).toLowerCase();
  return p.includes("box") || p.includes("بوكس");
}

export function labelPart(label: unknown): "bag_tag" | "keychain" | "box" | "body" | "" {
  const s = String(label ?? "").trim().toLowerCase();
  const words = s.split(/\s+/);
  if (s.includes("bag tag") || words.includes("tag") || words.includes("تاج")) return "bag_tag";   // "باج تاج"
  if (s.includes("ميدالي") || s.includes("keychain")) return "keychain";
  if (s.includes("بوكس") || s.includes("box") || s === "message") return "box";
  if (["برا", "بره", "جوا", "جوه", "محفظ"].some((k) => s.includes(k))) return "body";
  return "";
}

/** The laser pieces a line item makes (a bundle makes several). */
export function entryPieces(e: LaserEntry): Set<Piece> {
  const pieces = new Set<Piece>();
  if (isKeychain(e)) pieces.add("keychain");
  if (isWallet(e)) pieces.add("wallet");
  if (isPurse(e)) pieces.add("purse");
  if (isPassport(e)) pieces.add("passport");
  if (isBagTag(e)) pieces.add("bag_tag");
  if (isBox(e)) pieces.add(title(e).toLowerCase().includes("purse box") || pieces.has("purse") ? "purse_box" : "box");
  return pieces;
}

/** A single product keeps all its fields. In a bundle each piece keeps the fields
 *  labelled for it, and unlabelled ones stay on the box. */
export function belongs(label: unknown, part: Piece, parts: Set<Piece>): boolean {
  if (parts.size <= 1) return true;
  const lp = labelPart(label);
  if (lp === "body") return BODY_PIECES.includes(part);
  if (lp === "box" || !lp) return BOX_PIECES.includes(part);
  return lp === part;
}
export function partFields(e: LaserEntry, part: Piece): Array<[string, string]> {
  const parts = entryPieces(e);
  return e.customization_cleaned.filter(([l]) => belongs(l, part, parts));
}
/** The entry's placed customisation photos (position_label set) for `part`. */
export function partPhotos(e: LaserEntry, part: Piece): LaserPhoto[] {
  const parts = entryPieces(e);
  return (e.photo_numbers ?? []).filter((p) => (p.position_label ?? "").trim() && belongs(p.position_label, part, parts));
}
export function hasLaserPiece(e: LaserEntry): boolean {
  const parts = entryPieces(e);
  return LASER_PIECES.some((p) => parts.has(p));
}
/** A bundle's fields no laser piece takes, as an entry for the line-by-line file, or null. */
export function bundleLeftover(e: LaserEntry): LaserEntry | null {
  const parts = entryPieces(e);
  if (parts.size <= 1) return null;
  const orphan = (label: unknown) =>
    Boolean(labelPart(label)) && ![...parts].some((p) => LASER_PIECES.includes(p) && belongs(label, p, parts));
  const fields = e.customization_cleaned.filter(([l]) => orphan(l));
  const photos = (e.photo_numbers ?? []).filter((p) => (p.position_label ?? "").trim() && orphan(p.position_label));
  if (!fields.length && !photos.length) return null;
  return { ...e, customization_cleaned: fields, photo_numbers: photos };
}

export const BOX_STRIP = new Set(['"', "'", "«", "»", "“", "”", "‘", "’", "(", ")", "[", "]", "{", "}"]);
const APOSTROPHES = new Set(["'", "’", "‘"]);
const isLetter = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c);

/** Hearts the fonts have no glyph for: drawn as a vector heart (🫶 too). */
export const HEARTS = new Set([
  "❤", "♥", "♡", "❣", "🤍", "💙", "💚", "💛", "🧡", "💜", "🖤", "🤎",
  "💖", "💗", "💞", "💓", "💕", "💟", "💘", "💝", "🫶",
]);
/** Drawn as a vector infinity sign. */
export const INFINITY = "∞";
/** Variation selectors, joiner and skin tones: never drawn. */
export const SKIP_CHARS = new Set(["️", "︎", "‍", "🏻", "🏼", "🏽", "🏾", "🏿"]);
const isSymbol = (c: string) => HEARTS.has(c) || c === INFINITY;

/** Quotes and brackets removed; an apostrophe inside a word ("I’m") kept. */
export function stripQuotes(v: string): string {
  const cs = [...v];
  return cs.filter((c, i) => !BOX_STRIP.has(c) || (APOSTROPHES.has(c) && isLetter(cs[i - 1]) && isLetter(cs[i + 1]))).join("");
}

/** The heart goes at the END of the writing (owner, 2026-11-01): hearts (and an ∞)
 *  typed before it move after it; when it already ends with a heart, the opening
 *  hearts are not repeated. */
export function heartsLast(text: string): string {
  const cs = [...text];
  let i = 0;
  while (i < cs.length && (isSymbol(cs[i]!) || SKIP_CHARS.has(cs[i]!) || /\s/.test(cs[i]!))) i++;
  const lead = cs.slice(0, i).filter(isSymbol);
  if (!lead.some((c) => HEARTS.has(c)) || i === cs.length) return text;
  const rest = cs.slice(i).join("").trim();
  const tail = [...rest].filter((c) => !SKIP_CHARS.has(c) && !/\s/.test(c));
  const endsWithHeart = HEARTS.has(tail[tail.length - 1] ?? "");
  const moved = lead.filter((c) => !(endsWithHeart && HEARTS.has(c)));
  return moved.length ? `${rest} ${moved.join(" ")}` : rest;
}

/** Words with letters in them (a name with a heart is still one word). */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => [...w].some((c) => isLetter(c))).length;
}

/** A note to the team instead of writing ("نفس لوجو الطيارة اللي في صورة الويبسايت"):
 *  never engraved as text; the place gets a LOGO marker. */
export function isInstruction(text: string): boolean {
  return /لوجو|logo|(?:نفس|زي|زى|مثل)\s+(?:ال)?صور/i.test(text);
}

/** A note asking for the plane logo (the travel set's website photo). */
export function isPlaneNote(text: string): boolean {
  return /طيار|plane|✈/i.test(text);
}

/** Writing without quotes / brackets, with single spaces and its hearts at the end. */
export function cleanText(v: unknown): string {
  return heartsLast(stripQuotes(String(v ?? "")).split(/\s+/).filter(Boolean).join(" "));
}
export function qtyOf(e: LaserEntry): number {
  const q = Number(e.total_quantity || 1);
  return Number.isFinite(q) && q > 0 ? Math.floor(q) : 1;
}
/** [order, how many] per source order (quantity-expanded by the caller). */
export function sourcesOf(e: LaserEntry): Array<{ order: string | null; qty: number }> {
  const so = e.source_orders?.length ? e.source_orders : [{ order_name: undefined, remaining_quantity: qtyOf(e) }];
  return so.map((s) => ({ order: s.order_name ?? null, qty: Math.max(1, Math.floor(Number(s.remaining_quantity) || 1)) }));
}
