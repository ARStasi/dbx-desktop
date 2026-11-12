import type { ReactNode } from "react";
import { openExternal } from "../lib";

/**
 * Renders the Markdown in %md cells as React elements: headings, paragraphs,
 * lists, quotes, code, rules, and inline code, bold, italics and links. Raw
 * HTML is shown as text, never parsed, so a shared notebook cannot inject
 * markup or scripts into the app.
 */
export function Markdown(props: { text: string }) {
  return <div className="md">{blocks(props.text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={key()} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = Math.min(h[1].length, 4);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      out.push(<Tag key={key()}>{inline(h[2])}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key()}>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    const listRe = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
    const lm = listRe.exec(line);
    if (lm) {
      const ordered = /\d/.test(lm[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = listRe.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) {
          items.push(m[2]);
        } else if (lines[i].trim() !== "" && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += " " + lines[i].trim();
        } else {
          break;
        }
        i++;
      }
      const children = items.map((it, n) => <li key={n}>{inline(it)}</li>);
      out.push(ordered ? <ol key={key()}>{children}</ol> : <ul key={key()}>{children}</ul>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    if (para.length === 0) {
      // A line no rule matched; show it as is rather than loop.
      para.push(lines[i++].trim());
    }
    out.push(<p key={key()}>{inline(para.join(" "))}</p>);
  }
  return out;
}

const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_|\[([^\]]+)\]\(([^)\s]+)\)/;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `i${n++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined || m[3] !== undefined) out.push(<strong key={k}>{inline(m[2] ?? m[3])}</strong>);
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<em key={k}>{inline(m[4] ?? m[5])}</em>);
    else {
      const href = m[7];
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a
            key={k}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              openExternal(href);
            }}
          >
            {inline(m[6])}
          </a>
        ) : (
          <span key={k}>{inline(m[6])}</span>
        ),
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
