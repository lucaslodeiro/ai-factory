export const factoryCommandReference=`- \`/factory start [guidance]\` — start an open issue; optional guidance is issue-wide. Example: \`/factory start Keep the API small\`.
- \`/factory help\` — publish this command reference. Example: \`/factory help\`.
- \`/factory approve vN [guidance]\` — approve SPEC vN; optional guidance applies to that SPEC. Example: \`/factory approve v2 Preserve the public API\`.
- \`/factory answer <text>\` — answer the active question or request PR changes. Example: \`/factory answer Use SQLite\`.
- \`/factory retry [--issue] [--for <roles>] [guidance]\` — resume failed, paused or cancelled work and optionally add guidance. Example: \`/factory retry --for tester Do not use Chromium\`.
- \`/factory note [--issue] [--for <roles>] <text>\` — add guidance without changing state. Example: \`/factory note --issue Keep dependencies minimal\`.
- \`/factory replace <#N|id-prefix> [--issue] [--for <roles>] <text>\` — replace active guidance. Example: \`/factory replace #2 Use WebKit\`.
- \`/factory revoke <#N|id-prefix>\` — revoke active guidance. Example: \`/factory revoke #2\`.
- \`/factory pause [reason]\` — pause active work; the reason is audit evidence only. Example: \`/factory pause Waiting for product review\`.
- \`/factory cancel [reason]\` — cancel work; the reason is audit evidence only. Example: \`/factory cancel Product direction changed\`.`;

export function factoryHelpMarkdown(){return `# AI Factory commands\n\nThe command must be the first non-empty line. Text may continue on following lines. Roles are \`architect\`, \`builder\`, \`tester\` and \`reviewer\`.\n\n${factoryCommandReference}`;}
