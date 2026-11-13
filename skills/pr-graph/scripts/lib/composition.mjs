import { digest, requireValue } from "./graph.mjs";
import { step } from "./progress.mjs";

export function verifyPrefix(journal, key, verifyCommit) {
  requireValue(/^[0-9a-f]{64}$/.test(key), "Invalid composition prefix key.");
  const entries = [];
  const seen = new Set();
  for (let current = key; current;) {
    requireValue(!seen.has(current), "Composition prefix contains a cycle.");
    seen.add(current);
    const entry = journal.compositionPrefixes?.[current];
    const recipe = entry?.recipe;
    requireValue(recipe?.version === 1 && digest(recipe) === current &&
      /^[0-9a-f]{64}$/.test(recipe.execution) &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(recipe.target) &&
      (recipe.previous === null || /^[0-9a-f]{64}$/.test(recipe.previous)) &&
      typeof recipe.input?.id === "string" &&
      /^[0-9a-f]{64}$/.test(recipe.input.change) &&
      /^[0-9a-f]{64}$/.test(recipe.input.patch) &&
      typeof recipe.input.message === "string",
    "Invalid composition prefix; preserve it and inspect before reuse.");
    entries.push(entry);
    current = recipe.previous;
  }
  entries.reverse();
  let head = entries[0].recipe.target;
  for (const entry of entries) {
    const { recipe, commit } = entry;
    const receipt = journal.reconstructionReceipts?.[commit];
    requireValue(recipe.target === entries[0].recipe.target &&
      recipe.execution === entries[0].recipe.execution &&
      receipt?.recipe?.before === head && receipt.recipe.patch === recipe.input.patch &&
      receipt.recipe.message === recipe.input.message &&
      receipt.recipe.execution === recipe.execution &&
      digest(receipt.recipe) === commit && journal.commits[commit] === receipt.head,
    "Composition prefix differs from its reconstruction evidence.");
    verifyCommit(commit, receipt);
    head = receipt.head;
  }
  return { head, commits: entries.map((entry) => entry.commit) };
}

export function compositionCache(journal, {
  fingerprint, recordFingerprint = fingerprint, message, verifyCommit, verifyObjects = () => {},
}) {
  return (cwd, target, nodes, { recordOnly } = {}) => {
    if (!nodes.length || journal.commitCacheVersion !== 2) return null;
    const execution = recordOnly ? recordFingerprint(cwd) : fingerprint(cwd);
    const stats = journal.reconstruction ??= { cached: 0, inheritedCached: 0, applied: 0 };
    if (!recordOnly) stats.prefixMisses = (stats.prefixMisses ?? 0) + 1;
    if (!execution) return null;
    const recipes = [];
    const keys = [];
    for (const node of nodes) {
      const recipe = { version: 1, target, previous: keys.at(-1) ?? null, execution,
        input: { id: node.id, change: digest(node.change), patch: digest(node.change.patch),
          message: message(node.title) } };
      recipes.push(recipe);
      keys.push(digest(recipe));
    }
    const record = (index, head) => {
      const recipe = recipes[index];
      const previous = journal.compositionPrefixes?.[recipe.previous];
      if (index && !previous) return;
      const before = index
        ? journal.reconstructionReceipts[previous.commit].head : target;
      const commit = digest({ before, patch: recipe.input.patch,
        message: recipe.input.message, execution });
      if (journal.commits[commit] !== head || !journal.reconstructionReceipts?.[commit]) return;
      journal.compositionPrefixes ??= {};
      journal.compositionPrefixes[keys[index]] = { recipe, commit };
    };
    if (recordOnly) {
      record(nodes.length - 1, recordOnly);
      return null;
    }
    for (let i = keys.length - 1; i >= 0; i--) {
      if (!journal.compositionPrefixes?.[keys[i]]) continue;
      const reused = step(`Reusing verified composition prefix (${i + 1} changes)`, () => {
        const result = verifyPrefix(journal, keys[i], (key, receipt) => verifyCommit(cwd, key, receipt));
        // Check every snapshot, including target content overwritten by the prefix.
        verifyObjects(cwd, [target, ...result.commits.map((key) =>
          journal.reconstructionReceipts[key].head)]);
        return result;
      });
      stats.prefixMisses--;
      stats.prefixHits = (stats.prefixHits ?? 0) + 1;
      stats.prefixAvoided = (stats.prefixAvoided ?? 0) + i + 1;
      stats.cached += i + 1;
      stats.inheritedCached += reused.commits.filter((key) =>
        journal.inheritedReconstructions?.includes(key)).length;
      return { head: reused.head, length: i + 1, record };
    }
    return { head: target, length: 0, record };
  };
}
