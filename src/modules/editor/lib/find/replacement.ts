export function unquoteReplacement(value: string): string {
  return value.replace(/\\([nrt\\])/g, (_token, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    return "\\";
  });
}

export function preserveReplacementCase(
  source: string,
  replacement: string,
): string {
  if (!source || !replacement) return replacement;

  for (const separator of ["-", "_"] as const) {
    const sourceParts = source.split(separator);
    const replacementParts = replacement.split(separator);
    if (
      sourceParts.length > 1 &&
      sourceParts.length === replacementParts.length
    ) {
      return replacementParts
        .map((part, index) => preserveReplacementCase(sourceParts[index], part))
        .join(separator);
    }
  }

  if (source.toUpperCase() === source) return replacement.toUpperCase();
  if (source.toLowerCase() === source) return replacement.toLowerCase();
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function expandRegexReplacement(
  replacement: string,
  match: RegExpExecArray,
): string {
  return replacement.replace(/\$([$&]|\d+)/g, (token, reference: string) => {
    if (reference === "$") return "$";
    if (reference === "&") return match[0];

    for (let length = reference.length; length > 0; length -= 1) {
      const index = Number(reference.slice(0, length));
      if (index > 0 && index < match.length) {
        return (match[index] ?? "") + reference.slice(length);
      }
    }
    return token;
  });
}

export function replacementForMatch(input: {
  replacement: string;
  source: string;
  regexpMatch?: RegExpExecArray;
  preserveCase: boolean;
}): string {
  const replacement = unquoteReplacement(input.replacement);
  const expanded = input.regexpMatch
    ? expandRegexReplacement(replacement, input.regexpMatch)
    : replacement;
  return input.preserveCase
    ? preserveReplacementCase(input.source, expanded)
    : expanded;
}
