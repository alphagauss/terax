type Fence = {
  character: "`" | "~";
  length: number;
};

function readFence(line: string): Fence | null {
  const match = line.match(/^ {0,3}([`~]{3,})(.*)$/);
  if (!match) return null;

  const marker = match[1];
  const character = marker[0];
  if (character !== "`" && character !== "~") return null;
  if (marker.split(character).join("").length > 0) return null;

  return {
    character,
    length: marker.length,
  };
}

function isClosingFence(line: string, fence: Fence): boolean {
  const match = line.match(/^ {0,3}([`~]{3,})\s*$/);
  if (!match) return false;

  const marker = match[1];
  return (
    marker[0] === fence.character &&
    marker.length >= fence.length &&
    marker.split(fence.character).join("").length === 0
  );
}

function normalizeInlineMath(line: string): string {
  let result = "";
  let index = 0;

  while (index < line.length) {
    if (line[index] === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") runLength += 1;

      const closing = line.indexOf("`".repeat(runLength), index + runLength);
      if (closing === -1) {
        result += line.slice(index);
        break;
      }

      const end = closing + runLength;
      result += line.slice(index, end);
      index = end;
      continue;
    }

    const delimiter = line.slice(index, index + 2);
    if (delimiter === "\\(") {
      result += "$";
      index += 2;
      continue;
    }
    if (delimiter === "\\)") {
      result += "$";
      index += 2;
      continue;
    }
    if (delimiter === "\\[") {
      result += "$$";
      index += 2;
      continue;
    }
    if (delimiter === "\\]") {
      result += "$$";
      index += 2;
      continue;
    }

    result += line[index];
    index += 1;
  }

  return result;
}

export function normalizeMathDelimiters(
  content: string | undefined,
): string | undefined {
  if (content === undefined) return undefined;

  const parts = content.split(/(\r\n|\n|\r)/);
  let fence: Fence | null = null;

  return parts
    .map((part) => {
      if (/^\r\n|^\n|^\r$/.test(part)) return part;

      if (fence) {
        if (isClosingFence(part, fence)) fence = null;
        return part;
      }

      const nextFence = readFence(part);
      if (nextFence) {
        fence = nextFence;
        return part;
      }

      return normalizeInlineMath(part);
    })
    .join("");
}
