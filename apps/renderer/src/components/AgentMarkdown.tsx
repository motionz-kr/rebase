import { parseAgentMarkdown, type InlineNode, type MarkdownBlock } from '../lib/agentMarkdown';

function Inline({ node }: { node: InlineNode }) {
  if (node.type === 'text') return <>{node.text}</>;
  if (node.type === 'code') return <code>{node.text}</code>;
  if (node.type === 'strong') {
    return (
      <strong>
        {node.children.map((child, index) => (
          <Inline key={index} node={child} />
        ))}
      </strong>
    );
  }
  if (node.type === 'em') {
    return (
      <em>
        {node.children.map((child, index) => (
          <Inline key={index} node={child} />
        ))}
      </em>
    );
  }
  return (
    <a href={node.href} target="_blank" rel="noreferrer">
      {node.children.map((child, index) => (
        <Inline key={index} node={child} />
      ))}
    </a>
  );
}

function InlineList({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Inline key={index} node={node} />
      ))}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }) {
  if (block.type === 'heading') {
    const Tag = `h${block.level}` as 'h1' | 'h2' | 'h3';
    return (
      <Tag>
        <InlineList nodes={block.inline} />
      </Tag>
    );
  }
  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag>
        {block.items.map((item, index) => (
          <li key={index}>
            <InlineList nodes={item} />
          </li>
        ))}
      </Tag>
    );
  }
  if (block.type === 'code') {
    return (
      <pre>
        <code data-lang={block.lang || undefined}>{block.text}</code>
      </pre>
    );
  }
  if (block.type === 'table') {
    return (
      <div className="agent-markdown-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={index}>
                  <InlineList nodes={header} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    <InlineList nodes={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <p>
      <InlineList nodes={block.inline} />
    </p>
  );
}

export function AgentMarkdown({ text }: { text: string }) {
  const blocks = parseAgentMarkdown(text);
  return (
    <div className="agent-markdown">
      {blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </div>
  );
}
