/**
 * chunk — split a markdown document into heading-delimited sections.
 *
 * Each chunk is a coherent section (its heading line + body until the next
 * heading). Content before the first heading becomes a preamble chunk
 * (heading = null). The content hash lets ingest skip unchanged chunks.
 */
import { createHash } from "node:crypto";

export interface RawChunk {
  heading: string | null;
  content: string;
  contentHash: string;
}

export function chunkMarkdown(text: string): RawChunk[] {
  const lines = text.split(/\r?\n/);
  const sections: { heading: string | null; lines: string[] }[] = [];
  let current: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };

  const flush = () => {
    if (current.heading !== null || current.lines.some((l) => l.trim())) {
      sections.push(current);
    }
  };

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      current = { heading: m[2].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  return sections
    .map((s) => {
      const content = s.lines.join("\n").trim();
      return {
        heading: s.heading,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      };
    })
    .filter((c) => c.content.length > 0);
}
