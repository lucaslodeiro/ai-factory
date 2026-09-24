export const factoryCommandReference=`To start work, assign the issue to the Factory account, or use Add Issue in the dashboard.

- \`/factory help\` — publish this command reference. Example: \`/factory help\`.
- \`/factory approve vN [guidance]\` — approve brief vN, every recommendation in it and its split into stories when there is one, so Architect writes the specification; or approve the prototype of SPEC vN so the Builder starts. Optional guidance applies to that SPEC. Example: \`/factory approve v2 Preserve the public API\`.
- \`/factory answer <text>\` — answer the active question, change a brief decision, request PR changes or request a revised SPEC after an invalid result. Example: \`/factory answer Use SQLite\`.
- \`/factory retry [--issue] [--for <roles>] [guidance]\` — resume failed, paused or cancelled work and optionally add guidance. Example: \`/factory retry --for tester Do not use Chromium\`.
- \`/factory note [--issue] [--for <roles>] <text>\` — add guidance without changing state. Example: \`/factory note --issue Keep dependencies minimal\`.
- \`/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>\` — replace active guidance. Example: \`/factory replace #2 Use WebKit\`.
- \`/factory revoke <#N|id-prefix>\` — revoke active guidance. Example: \`/factory revoke #2\`.
- \`/factory budget +<tokens> [reason]\` — extend this issue's token budget and acknowledge runs that finished without reported usage; \`+0\` only acknowledges them. Example: \`/factory budget +250000 Larger refactor than expected\`.
- \`/factory pause [reason]\` — pause active work; the reason is audit evidence only. Example: \`/factory pause Waiting for product review\`.
- \`/factory cancel [reason]\` — cancel work; the reason is audit evidence only. Example: \`/factory cancel Product direction changed\`.`;

export function factoryHelpMarkdown(){return `# AI Factory commands\n\nPut the command on the first or the last non-empty line. The other lines become its text. If both lines are commands, the first wins and the last is treated as text. Roles are \`architect\`, \`builder\`, \`tester\` and \`reviewer\`.\n\n${factoryCommandReference}`;}
