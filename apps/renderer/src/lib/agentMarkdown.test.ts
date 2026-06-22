import { describe, expect, it } from 'vitest';
import { parseAgentMarkdown } from './agentMarkdown';

describe('parseAgentMarkdown', () => {
  it('parses common agent markdown blocks', () => {
    const blocks = parseAgentMarkdown(`# Summary

- **users** table
- Run \`SELECT\`

\`\`\`sql
SELECT * FROM users;
\`\`\`
`);

    expect(blocks).toMatchObject([
      { type: 'heading', level: 1 },
      { type: 'list', ordered: false, items: expect.arrayContaining([expect.any(Array)]) },
      { type: 'code', lang: 'sql', text: 'SELECT * FROM users;' },
    ]);
  });

  it('does not treat raw html as markup', () => {
    const blocks = parseAgentMarkdown('Hello <script>alert(1)</script>');

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        inline: [{ type: 'text', text: 'Hello <script>alert(1)</script>' }],
      },
    ]);
  });

  it('parses markdown tables', () => {
    const blocks = parseAgentMarkdown(`| Column | Type | Nullable | Primary Key |
|--------|------|----------|-------------|
| id | int | No | Yes |
| name | varchar | No | No |`);

    expect(blocks).toMatchObject([
      {
        type: 'table',
        headers: [[{ type: 'text', text: 'Column' }], [{ type: 'text', text: 'Type' }], [{ type: 'text', text: 'Nullable' }], [{ type: 'text', text: 'Primary Key' }]],
        rows: [
          [[{ type: 'text', text: 'id' }], [{ type: 'text', text: 'int' }], [{ type: 'text', text: 'No' }], [{ type: 'text', text: 'Yes' }]],
          [[{ type: 'text', text: 'name' }], [{ type: 'text', text: 'varchar' }], [{ type: 'text', text: 'No' }], [{ type: 'text', text: 'No' }]],
        ],
      },
    ]);
  });

  it('parses compact pipe tables when line breaks are lost', () => {
    const blocks = parseAgentMarkdown('| Column | Type | |--------|------| | id | int |');

    expect(blocks).toMatchObject([
      {
        type: 'table',
        headers: [[{ type: 'text', text: 'Column' }], [{ type: 'text', text: 'Type' }]],
        rows: [[[{ type: 'text', text: 'id' }], [{ type: 'text', text: 'int' }]]],
      },
    ]);
  });
});
