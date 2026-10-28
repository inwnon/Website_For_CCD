// PostToolUse hook (Write|Edit): ESLint on the one file Claude just changed (same rules as npm run lint).
// Clean or not a lintable file: silent, exit 0. Problems: a short list on stderr, exit 2 (Claude sees it and fixes it).
import { relative, resolve } from 'node:path';
import { ESLint } from 'eslint';

const MAX_LINES = 20;
let input = '';
for await (const chunk of process.stdin) input += chunk;

const root = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
const { tool_input: t = {}, tool_response: r = {} } = JSON.parse(input || '{}');
const file = t.file_path || r.filePath;
if (!file || !/\.(m?js|cjs|html)$/i.test(file)) process.exit(0);
const path = resolve(root, file);
if (relative(root, path).startsWith('..')) process.exit(0); // outside the project

const eslint = new ESLint({ cwd: root, warnIgnored: false });
if (await eslint.isPathIgnored(path)) process.exit(0);
const [result] = await eslint.lintFiles([path]);
if (!result?.messages.length) process.exit(0);

const lines = result.messages.map((m) => `${m.line}:${m.column} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`);
const more = lines.length > MAX_LINES ? `\n…and ${lines.length - MAX_LINES} more` : '';
process.stderr.write(`ESLint: ${relative(root, path)}\n${lines.slice(0, MAX_LINES).join('\n')}${more}\n`);
process.exit(2);
