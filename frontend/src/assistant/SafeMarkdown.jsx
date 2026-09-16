import React from 'react';

function inline(text, keyPrefix = 'text') {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} style={styles.code}>{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={key}>{part}</React.Fragment>;
  });
}

function cells(line) {
  return String(line || '')
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(line) {
  const values = cells(line);
  return values.length > 0 && values.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export default function SafeMarkdown({ children }) {
  const lines = String(children || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      blocks.push(
        <div key={`table-${index}`} style={styles.tableWrap}>
          <table style={styles.table}>
            <thead><tr>{header.map((cell, i) => <th key={i} style={styles.th}>{inline(cell, `h-${i}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, cellIndex) => <td key={cellIndex} style={styles.td}>{inline(row[cellIndex] || '', `r-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}`;
      blocks.push(<Tag key={`heading-${index}`} style={styles[`h${level}`]}>{inline(heading[2], `heading-${index}`)}</Tag>);
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`} style={styles.list}>{items.map((item, i) => <li key={i}>{inline(item, `li-${i}`)}</li>)}</ul>);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,3})\s+|^[-*+]\s+/.test(lines[index])) {
      if (lines[index].includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`paragraph-${index}`} style={styles.paragraph}>{inline(paragraph.join('\n'), `p-${index}`)}</p>);
  }

  return <>{blocks}</>;
}

const styles = {
  h1: { margin: '0 0 10px', fontSize: '1.25rem' },
  h2: { margin: '0 0 8px', fontSize: '1.12rem' },
  h3: { margin: '0 0 6px', fontSize: '1rem' },
  paragraph: { margin: '0 0 10px', whiteSpace: 'pre-wrap', lineHeight: 1.55 },
  list: { margin: '0 0 10px', paddingLeft: 20, lineHeight: 1.55 },
  code: { padding: '1px 4px', borderRadius: 4, background: 'rgba(148,163,184,.2)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.9em' },
  tableWrap: { overflowX: 'auto', margin: '0 0 10px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '.92em' },
  th: { textAlign: 'left', padding: '7px 9px', borderBottom: '1px solid var(--border-soft)', background: 'rgba(148,163,184,.12)' },
  td: { padding: '7px 9px', borderBottom: '1px solid var(--border-soft)', verticalAlign: 'top' },
};
