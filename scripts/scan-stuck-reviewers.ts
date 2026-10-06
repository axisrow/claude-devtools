// One-off sweep #4: resolve each AO reviewer's actual review target (repo, PR,
// title) from raw transcript text — the request file content and `gh pr view`
// output land in the transcript when the reviewer reads them.
import * as fs from 'fs';
import * as path from 'path';

const BASE = '/Users/axisrow/.claude/projects';
const REVIEWERS: [string, string][] = [
  [
    '-Users-axisrow--ao-data-worktrees-claude-devtools-claude-devtools-14',
    '0779a2bc-5c55-52bf-a83f-62708c359deb',
  ],
  ['-Users-axisrow--ao-data-worktrees-tg-use-tg-use-11', 'c45fff1e-c823-5411-ae53-fb167ad82e91'],
  ['-Users-axisrow--ao-data-worktrees-hhru-hhru-599', 'c0845281-62e4-5e06-b0e5-72bf3068cf79'],
  [dir('tg-content-factory', 92), '6bcb55d0-a4cb-556f-bf05-2f7bbfaab589'],
  [dir('tg-content-factory', 91), '7190e096-6bd6-521e-b44b-9da929c41c7b'],
  ['-Users-axisrow--ao-data-worktrees-tg-use-tg-use-12', '96969cdb-5715-5df7-b289-ee59f203a975'],
  [
    '-Users-axisrow--ao-data-worktrees-ccstatusline-ccstatusline-3',
    'ea2870de-c0f4-5610-b27f-10df34c10d51',
  ],
];

function dir(repo: string, n: number): string {
  return `-Users-axisrow--ao-data-worktrees-tg-content-factory-tg-content-factory-${n}`;
}

for (const [dir, uuid] of REVIEWERS) {
  const file = path.join(BASE, dir, `${uuid}.jsonl`);
  const raw = fs.readFileSync(file, 'utf8');
  const repo =
    raw
      .match(/pull\/(axisrow|sirmalloc)\/([\w.-]+)\/pull\/(\d+)/)
      ?.slice(2)
      .join('#') ??
    raw
      .match(/(?:axisrow|sirmalloc)\/([\w.-]+)\/pull\/(\d+)/)
      ?.slice(1)
      .join('#') ??
    raw
      .match(/([\w-]+)\/pull\/(\d+)/)
      ?.slice(1)
      .join('#') ??
    'target?';
  const title = raw.match(/"title":"([^"]{5,130})"/)?.[1] ?? '';
  console.log(`${uuid.slice(0, 8)}  →  ${repo}${title ? `\n          «${title}»` : ''}`);
}
