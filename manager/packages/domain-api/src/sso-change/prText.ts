// D-MSSO-10/19: the text of the commit and pull request. Shared by the submit route and the reconciler's recovery
// path so both produce the same PR. All user-controlled values (username, sub, reason) are neutralised here.

const oneLine = (text: string): string => text.replace(/[\u0000-\u001F\u007F\s]+/g, " ").trim();

// Requester names end up in Markdown: escape it so it renders as plain text (no links, HTML, mentions, headings).
function escapeMarkdown(text: string): string {
  return oneLine(text).replace(/[\\`*_{}[\]<>()#+\-.!|~@&:]/g, "\\$&");
}

export function prTitle(endpoint: string): string {
  return `chore(gitops): update allowedGroups of ${endpoint} via Manager`;
}

/** Subject + blank line + trailer. The trailer values are single-line so they cannot smuggle further trailers. */
export function commitMessage(input: { endpoint: string; username: string | undefined; sub: string }): string {
  return `chore(sso): ${input.endpoint} allowedGroups via Manager\n\nRequested-by: ${oneLine(input.username ?? "unknown")} (${oneLine(input.sub)})`;
}

export function prBody(input: {
  username: string | undefined;
  sub: string;
  reason: string | undefined;
  baseBlobSha: string;
  sourceCommitSha: string;
  diff: string;
}): string {
  // The reason is free text: stripped of backticks it cannot close the fence, and inside a code block nothing renders.
  const reason = input.reason ? input.reason.replace(/`/g, "").replace(/\r\n?/g, "\n") : "(none given)";
  return [
    "Requested through Beluga Manager (ADR-0009). Review like any other change; the Manager never merges.",
    "",
    `Requested-by: ${escapeMarkdown(input.username ?? "unknown")} (${escapeMarkdown(input.sub)})`,
    `Base-blob-sha: ${input.baseBlobSha}`,
    `Source-commit-sha: ${input.sourceCommitSha}`,
    "",
    "Reason:",
    "```text",
    reason,
    "```",
    "",
    "````diff",
    input.diff,
    "````",
  ].join("\n");
}
