export type CommitStyle = "conventional" | "gitmoji" | "concise";

const CONVENTIONAL_REGEX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .+/i;

const GITMOJI_REGEX =
  /^(:[a-z0-9_-]+:|\p{Extended_Pictographic}|\p{Emoji_Presentation})/u;

/**
 * Inspects a list of commit messages (typically from git log -n 10 --oneline)
 * and detects the predominant style.
 */
export function detectCommitConvention(commitMessages: string[]): CommitStyle {
  if (!commitMessages || commitMessages.length === 0) {
    return "conventional";
  }

  let conventionalCount = 0;
  let gitmojiCount = 0;
  let validCount = 0;

  for (const rawMsg of commitMessages) {
    let msg = rawMsg.trim();
    if (!msg) continue;

    // If message starts with a git commit hash (e.g. from --oneline), strip it
    const firstSpace = msg.indexOf(" ");
    if (firstSpace !== -1 && /^[a-f0-9]+$/i.test(msg.slice(0, firstSpace))) {
      msg = msg.slice(firstSpace + 1).trim();
    }

    validCount++;
    if (CONVENTIONAL_REGEX.test(msg)) {
      conventionalCount++;
    } else if (GITMOJI_REGEX.test(msg)) {
      gitmojiCount++;
    }
  }

  if (validCount === 0) {
    return "conventional";
  }

  if (conventionalCount / validCount >= 0.4) {
    return "conventional";
  }
  if (gitmojiCount / validCount >= 0.3) {
    return "gitmoji";
  }

  return "concise";
}
