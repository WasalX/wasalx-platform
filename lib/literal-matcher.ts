const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

export function normalizeMessage(input: string): string {
  const normalized = input
    .normalize("NFC")
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EASTERN_ARABIC_INDIC.indexOf(digit)))
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  return Array.from(normalized).filter((character) => {
    const code = character.charCodeAt(0);
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("");
}

type LocatedMatch = { value: string; start: number; end: number };

export function containsMatches(input: string, literal: string, limit: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperLiteral = literal.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - literal.length && matches.length < limit) {
    const start = upperInput.indexOf(upperLiteral, cursor);
    if (start < 0) break;
    const end = start + literal.length;
    matches.push({ value: input.slice(start, end), start, end });
    cursor = end;
  }
  return matches;
}

function isAsciiDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

export function isAsciiWord(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "_"
  );
}

export function exactLengthMatches(input: string, length: number, limit: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  for (let index = 0; index < input.length && matches.length < limit; ) {
    if (!isAsciiDigit(input[index])) {
      index += 1;
      continue;
    }
    const start = index;
    while (isAsciiDigit(input[index])) index += 1;
    if (index - start === length) {
      matches.push({ value: input.slice(start, index), start, end: index });
    }
  }
  return matches;
}

export function prefixLengthMatches(input: string, prefix: string, length: number, limit: number): LocatedMatch[] {
  const matches: LocatedMatch[] = [];
  const upperInput = input.toUpperCase();
  const upperPrefix = prefix.toUpperCase();
  let cursor = 0;
  while (cursor <= input.length - prefix.length - length && matches.length < limit) {
    const start = upperInput.indexOf(upperPrefix, cursor);
    if (start < 0) break;
    const digitsStart = start + prefix.length;
    const end = digitsStart + length;
    const validDigits = input.slice(digitsStart, end).length === length &&
      Array.from(input.slice(digitsStart, end)).every(isAsciiDigit);
    if (
      validDigits &&
      !isAsciiWord(input[start - 1]) &&
      !isAsciiWord(input[end])
    ) {
      matches.push({ value: input.slice(start, end), start, end });
    }
    cursor = start + Math.max(1, prefix.length);
  }
  return matches;
}

