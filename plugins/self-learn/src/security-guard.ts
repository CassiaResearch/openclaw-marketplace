/**
 * Security guard for self-learned skills.
 * Mirrors Hermes Agent's skills_guard.py — scans skill content for threat patterns.
 *
 * Agent-created skills get the strictest scrutiny:
 *   safe / caution → allowed
 *   dangerous / ask → blocked + rollback
 */

export type ThreatLevel = "safe" | "caution" | "dangerous";

export type ScanResult = {
  level: ThreatLevel;
  threats: string[];
};

type ThreatPattern = {
  pattern: RegExp;
  description: string;
  level: ThreatLevel;
};

const THREAT_PATTERNS: ThreatPattern[] = [
  // Exfiltration
  { pattern: /curl\s[^|]*\|/i, description: "curl piping output (potential exfiltration)", level: "dangerous" },
  { pattern: /wget\s+-O\s*-/i, description: "wget output to stdout (potential exfiltration)", level: "dangerous" },
  { pattern: /\bnc\s+-[^l]/i, description: "netcat connection (potential exfiltration)", level: "dangerous" },
  { pattern: /\bncat\s/i, description: "ncat connection (potential exfiltration)", level: "dangerous" },

  // Prompt injection
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/i, description: "prompt injection: ignore previous instructions", level: "dangerous" },
  { pattern: /you\s+are\s+now\s+/i, description: "prompt injection: role override", level: "dangerous" },
  { pattern: /<system>/i, description: "prompt injection: system tag", level: "dangerous" },
  { pattern: /\[INST\]/i, description: "prompt injection: instruction tag", level: "dangerous" },

  // Destructive commands
  { pattern: /rm\s+-rf\s+\//i, description: "destructive: rm -rf /", level: "dangerous" },
  { pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;/i, description: "destructive: fork bomb", level: "dangerous" },
  { pattern: /\bmkfs\b/i, description: "destructive: filesystem format", level: "dangerous" },
  { pattern: /\bdd\s+if=/i, description: "destructive: dd disk write", level: "caution" },
  { pattern: /DROP\s+(TABLE|DATABASE)/i, description: "destructive: SQL drop", level: "caution" },

  // Persistence
  { pattern: /crontab\s+-/i, description: "persistence: crontab modification", level: "caution" },
  { pattern: /systemctl\s+enable/i, description: "persistence: systemd enable", level: "caution" },
  { pattern: /launchctl\s+load/i, description: "persistence: launchctl load", level: "caution" },
  { pattern: /@reboot\s/i, description: "persistence: cron @reboot", level: "caution" },

  // Credential access
  { pattern: /cat\s+~\/\.ssh/i, description: "credential access: SSH keys", level: "dangerous" },
  { pattern: /cat\s+\/etc\/shadow/i, description: "credential access: shadow file", level: "dangerous" },
  { pattern: /\$GITHUB_TOKEN/i, description: "credential access: GITHUB_TOKEN reference", level: "caution" },
  { pattern: /\$AWS_SECRET/i, description: "credential access: AWS_SECRET reference", level: "caution" },

  // Path traversal
  { pattern: /\.\.\//g, description: "path traversal: ../ sequence", level: "caution" },
];

/**
 * Strip fenced code blocks from content so patterns inside code examples
 * are not flagged. This mirrors Hermes's approach of only scanning
 * non-code-block contexts for certain threat categories.
 */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "");
}

/**
 * Scan skill content for threat patterns.
 * Returns the highest threat level found and a list of threats.
 */
export function scanSkillContent(content: string): ScanResult {
  const threats: string[] = [];
  let maxLevel: ThreatLevel = "safe";

  const stripped = stripCodeBlocks(content);

  for (const { pattern, description, level } of THREAT_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(stripped)) {
      threats.push(description);
      if (level === "dangerous") {
        maxLevel = "dangerous";
      } else if (level === "caution" && maxLevel !== "dangerous") {
        maxLevel = "caution";
      }
    }
  }

  return { level: maxLevel, threats };
}

/**
 * Check whether the scan result allows the write to proceed.
 * For agent-created skills: safe/caution = allowed, dangerous = blocked.
 */
export function isWriteAllowed(result: ScanResult): boolean {
  return result.level !== "dangerous";
}

/**
 * Format a scan result as a human-readable error message.
 */
export function formatScanError(result: ScanResult): string {
  const lines = [
    `Security scan blocked this skill (threat level: ${result.level}).`,
    "Detected threats:",
    ...result.threats.map((t) => `  - ${t}`),
    "",
    "Remove the flagged patterns and try again.",
  ];
  return lines.join("\n");
}
