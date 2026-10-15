export function localProvider() {
  return {
    kind: "local",
    capabilities: () => ({ drafts: false, retarget: false, strategies: ["merge", "squash", "rebase"] }),
    find: () => null,
  };
}
