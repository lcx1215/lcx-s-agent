export type UpgradePromptBullet = {
  label: string;
  value: string;
};

export function renderUpgradePrompt(params: {
  heading: string;
  intro: string;
  rangeLabel: string;
  bullets: UpgradePromptBullet[];
  cueTitle?: string;
  cueBody: string;
}): string {
  return [
    `# ${params.heading}`,
    "",
    params.intro,
    "",
    `- **Window**: ${params.rangeLabel}`,
    ...params.bullets.map((bullet) => `- **${bullet.label}**: ${bullet.value}`),
    "",
    `## ${params.cueTitle ?? "Default Upgrade Cue"}`,
    params.cueBody,
    "",
  ].join("\n");
}
