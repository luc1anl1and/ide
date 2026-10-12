// JS & React Snippets - the snippets and the ".env" language are declared in plugin.json ("contributes"),
// so Reva loads them without running any code. This script adds what JSON cannot: syntax highlighting
// for .env files and a few extra snippets registered from code.

exports.activate = (reva) => {
  // A Monarch tokenizer: KEY=value lines, # comments, quoted strings, ${VAR} references.
  reva.editor.registerTokenizer('dotenv', {
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        [/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.]*(?==)/, 'variable'],
        [/=/, 'delimiter'],
        [/\$\{[^}]*\}/, 'type'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'[^']*'/, 'string'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/[^#\s"'$]+/, 'string'],
      ],
    },
  });

  // Snippets from code: same format as the JSON file (VS Code style), or a plain array.
  reva.editor.registerSnippets('dotenv', [
    { prefix: 'db', body: ['DATABASE_URL=postgres://${1:user}:${2:password}@${3:localhost}:5432/${4:db}'], description: 'Database URL' },
    { prefix: 'port', body: ['PORT=${1:3000}'], description: 'Port number' },
  ]);
};
