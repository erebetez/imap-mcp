/**
 * Prompt-injection guard for email content.
 *
 * Email bodies are attacker-controlled text that gets handed straight to an
 * LLM client. This strips the tricks used to sneak instructions past a human
 * reader while an LLM still parses them: invisible/zero-width Unicode,
 * bidi-override reordering, CSS-hidden HTML, and shouted "SYSTEM:"-style
 * directive lines. It's a mitigation layer, not a guarantee -- callers must
 * still treat email content as untrusted data.
 *
 * All character-class regexes below are built from \uXXXX escape strings
 * (rather than written as literal characters in this file) so the source
 * never itself contains invisible/zero-width codepoints.
 */
'use strict';

// Zero-width joiners/spaces, bidi embedding/override/isolate controls, and
// other formatting characters that render as nothing but are still read by
// an LLM as text:
//   U+00AD          soft hyphen
//   U+034F          combining grapheme joiner
//   U+200B-U+200F   zero-width space/non-joiner/joiner, LRM/RLM
//   U+202A-U+202E   bidi embedding/override controls
//   U+2060-U+2064   word joiner, invisible math operators
//   U+2066-U+2069   bidi isolate controls
//   U+FEFF          BOM / zero-width no-break space
//   U+FFF9-U+FFFB   interlinear annotation controls
const ZERO_WIDTH_AND_BIDI_RE = new RegExp(
  '[\\u00AD\\u034F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\uFFF9-\\uFFFB]',
  'g'
);

// C0/C1 control characters other than tab/newline/carriage-return.
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

// Variation selectors (U+FE00-U+FE0F, U+E0100-U+E01EF) and Unicode "tag"
// characters (U+E0000-U+E007F, the emoji-flag steganography trick) -- both
// invisible, both used to smuggle hidden text.
const TAG_AND_VARIATION_RE = new RegExp(
  '[\\uFE00-\\uFE0F\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]',
  'gu'
);

function stripInvisibleChars(str) {
  if (!str) return str;
  return str
    .replace(ZERO_WIDTH_AND_BIDI_RE, '')
    .replace(TAG_AND_VARIATION_RE, '')
    .replace(CONTROL_CHARS_RE, '');
}

const SHOUTING_MIN_LETTERS = 15;
const SHOUTING_UPPER_RATIO = 0.85;
const SHOUTING_PLACEHOLDER = '[REDACTED: all-caps line removed by prompt-injection guard]';

function isShoutingLine(line) {
  const letters = line.match(/\p{L}/gu);
  if (!letters || letters.length < SHOUTING_MIN_LETTERS) return false;
  const upper = line.match(/\p{Lu}/gu) || [];
  return upper.length / letters.length >= SHOUTING_UPPER_RATIO;
}

// Redacts lines that read like an injected "IGNORE ALL PREVIOUS
// INSTRUCTIONS..." directive -- long, almost entirely uppercase lines,
// which is a common way attackers make injected text stand out to a model.
function neutralizeShoutingLines(text) {
  if (!text) return text;
  return text
    .split('\n')
    .map((line) => (isShoutingLine(line) ? SHOUTING_PLACEHOLDER : line))
    .join('\n');
}

// Best-effort: blanks the contents of HTML elements hidden from a human
// reader via inline style (display:none, visibility:hidden, opacity:0,
// font-size:0) -- a common way to smuggle instructions into an HTML email
// that only a raw-markup reader (i.e. an LLM) would see. Regex-based, so it
// won't catch every case (e.g. hiding via an external stylesheet), but
// covers the common inline-style attack.
const HIDDEN_STYLE_RE = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0*)?\s*[;"']|font-size\s*:\s*0(?:\.0*)?(?:px)?\s*[;"']/i;
const HTML_ELEMENT_RE = /<([a-z][a-z0-9]*)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

function stripHiddenHtml(html) {
  if (!html) return html;
  return html.replace(HTML_ELEMENT_RE, (whole, tag, attrs) => {
    const styleMatch = attrs.match(/style\s*=\s*"([^"]*)"|style\s*=\s*'([^']*)'/i);
    const style = styleMatch ? (styleMatch[1] || styleMatch[2] || '') : '';
    if (HIDDEN_STYLE_RE.test(style + ';')) return `<${tag}${attrs}></${tag}>`;
    return whole;
  });
}

function sanitizeAddress(addr) {
  if (!addr) return addr;
  if (addr.name) addr.name = stripInvisibleChars(addr.name);
  if (addr.address) addr.address = stripInvisibleChars(addr.address);
  if (addr.group) addr.group.forEach(sanitizeAddress);
  return addr;
}

// Applies every guard to a postal-mime parsed message in place and returns
// it. Call this on every parsed email before it reaches an LLM client or the
// local cache.
function sanitizeParsedEmail(parsed) {
  if (!parsed) return parsed;
  if (parsed.subject) parsed.subject = neutralizeShoutingLines(stripInvisibleChars(parsed.subject));
  if (parsed.text) parsed.text = neutralizeShoutingLines(stripInvisibleChars(parsed.text));
  if (parsed.html) parsed.html = stripInvisibleChars(stripHiddenHtml(parsed.html));
  sanitizeAddress(parsed.from);
  if (Array.isArray(parsed.to)) parsed.to.forEach(sanitizeAddress);
  if (Array.isArray(parsed.cc)) parsed.cc.forEach(sanitizeAddress);
  return parsed;
}

module.exports = {
  stripInvisibleChars,
  neutralizeShoutingLines,
  stripHiddenHtml,
  sanitizeParsedEmail,
};
