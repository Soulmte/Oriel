import { Fragment } from "react";
import type { ReactNode } from "react";

/**
 * Minimal Markdown renderer for release notes.
 *
 * Release bodies come from GitHub, i.e. from whoever publishes a release, so it
 * builds React nodes instead of injecting HTML: no `dangerouslySetInnerHTML`, and
 * links only survive if they are http(s). It covers what release notes actually
 * use — headings, lists, code, quotes, rules and inline emphasis.
 */

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;

function renderLink(raw: string, key: string): ReactNode {
  const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
  if (!match) return raw;
  const [, label, href] = match;
  if (!/^https?:\/\//i.test(href)) return <Fragment key={key}>{label}</Fragment>;
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-mac-blue underline decoration-mac-blue/40 underline-offset-2 hover:decoration-mac-blue"
    >
      {label}
    </a>
  );
}

function renderInline(text: string, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push(text.slice(cursor, start));

    const token = match[0];
    const key = `${prefix}-${index++}`;

    if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[11.5px] dark:bg-white/10"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold text-mac-text">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      nodes.push(renderLink(token, key));
    }

    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];

  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] as string;

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] as string).trim().startsWith("```")) {
        body.push(lines[index] as string);
        index += 1;
      }
      index += 1;
      blocks.push(
        <pre
          key={`code-${key++}`}
          className="my-2 overflow-x-auto rounded-md bg-black/[0.05] p-2 font-mono text-[11.5px] leading-5 text-mac-text dark:bg-white/[0.07]"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${key++}`} className="my-3 border-mac-line" />);
      index += 1;
      continue;
    }

    // Headings
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const content = renderInline((heading[2] as string).trim(), `h${key}`);
      const className =
        level <= 2
          ? "mt-3 mb-1 text-[13px] font-semibold text-mac-text"
          : "mt-2 mb-1 text-[12.5px] font-semibold text-mac-text";
      blocks.push(
        level <= 2 ? (
          <h3 key={`h-${key++}`} className={className}>
            {content}
          </h3>
        ) : (
          <h4 key={`h-${key++}`} className={className}>
            {content}
          </h4>
        ),
      );
      index += 1;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] as string)) {
        body.push((lines[index] as string).replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote-${key++}`}
          className="my-2 border-l-2 border-mac-blue/40 pl-2.5 text-mac-muted"
        >
          {renderInline(body.join(" "), `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    // GFM table: header row, separator row, then body rows
    const isTableHeader =
      /^\s*\|/.test(line) &&
      index + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|?\s*$/.test(lines[index + 1] as string);

    if (isTableHeader) {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());

      const header = splitRow(line);
      index += 2;

      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index] as string)) {
        rows.push(splitRow(lines[index] as string));
        index += 1;
      }

      blocks.push(
        <div key={`table-${key++}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[11.5px]">
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th
                    key={`th-${cellIndex}`}
                    className="border-b border-mac-line px-2 py-1 text-left font-semibold text-mac-text"
                  >
                    {renderInline(cell, `th${key}-${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`tr-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`td-${rowIndex}-${cellIndex}`}
                      className="border-b border-mac-line/60 px-2 py-1 align-top"
                    >
                      {renderInline(cell, `td${key}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lists (bulleted or numbered)
    const bullet = /^\s*[-*+]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] as string;
        const match = ordered ? numbered.exec(current) : bullet.exec(current);
        if (!match) break;
        items.push(match[1] as string);
        index += 1;
      }

      const children = items.map((item, itemIndex) => (
        <li key={`li-${key}-${itemIndex}`} className="leading-5">
          {renderInline(item, `li${key}-${itemIndex}`)}
        </li>
      ));

      blocks.push(
        ordered ? (
          <ol key={`list-${key++}`} className="my-1.5 ml-4 list-decimal space-y-0.5">
            {children}
          </ol>
        ) : (
          <ul key={`list-${key++}`} className="my-1.5 ml-4 list-disc space-y-0.5">
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph: consume until a blank line or a block starter
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] as string;
      if (
        !current.trim() ||
        /^\s*(```|>|#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(current) ||
        /^\s*([-*_])\1{2,}\s*$/.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }

    blocks.push(
      <p key={`p-${key++}`} className="my-1.5 leading-5">
        {renderInline(paragraph.join(" "), `p${key}`)}
      </p>,
    );
  }

  return <>{blocks}</>;
}
