import { describe, expect, it } from "vitest";
import type { SnippetFolder, SnippetLeaf, SnippetNode } from "./types";
import {
  childrenForFolder,
  descendantFolderIds,
  findSnippetFolder,
  findSnippetNode,
  flattenSnippets,
  folderOptions,
  insertSnippetNode,
  moveSnippetNode,
  removeSnippetNode,
  reorderSnippetNode,
  snippetFolderPath,
  updateSnippetNode,
} from "./snippets";

function snippet(id: string, name = id, text = `${id} text`): SnippetLeaf {
  return { id, type: "snippet", name, text };
}

function folder(id: string, name: string, children: SnippetNode[] = []): SnippetFolder {
  return { id, type: "folder", name, children };
}

function fixture(): SnippetNode[] {
  return [
    folder("engineering", "Engineering", [
      snippet("test", "Run tests", "npm test"),
      folder("deploy", "Deploy", [
        snippet("staging", "Deploy staging", "deploy staging"),
        folder("production", "Production", [
          snippet("rollback", "Rollback", "rollback --latest"),
        ]),
      ]),
    ]),
    folder("personal", "Personal", [snippet("note", "Take note", "remember this")]),
    snippet("root-command", "Root command", "pwd"),
  ];
}

describe("snippet tree lookup and projection", () => {
  it("finds nested nodes and folders, resolves paths, and lists folder children", () => {
    const tree = fixture();

    expect(findSnippetNode(tree, "rollback")).toMatchObject({
      id: "rollback",
      type: "snippet",
      text: "rollback --latest",
    });
    expect(findSnippetNode(tree, "missing")).toBeNull();
    expect(findSnippetFolder(tree, "deploy")?.name).toBe("Deploy");
    expect(findSnippetFolder(tree, "staging")).toBeNull();
    expect(findSnippetFolder(tree, null)).toBeNull();

    expect(snippetFolderPath(tree, "production").map((item) => item.id)).toEqual([
      "engineering",
      "deploy",
      "production",
    ]);
    expect(snippetFolderPath(tree, "missing")).toEqual([]);
    expect(childrenForFolder(tree, "deploy").map((item) => item.id)).toEqual([
      "staging",
      "production",
    ]);
    expect(childrenForFolder(tree, null)).toBe(tree);
    expect(childrenForFolder(tree, "missing")).toEqual([]);
  });

  it("flattens only snippet leaves with their complete folder paths in tree order", () => {
    const entries = flattenSnippets(fixture());

    expect(entries.map(({ snippet: item, path }) => ({ id: item.id, path }))).toEqual([
      { id: "test", path: ["Engineering"] },
      { id: "staging", path: ["Engineering", "Deploy"] },
      { id: "rollback", path: ["Engineering", "Deploy", "Production"] },
      { id: "note", path: ["Personal"] },
      { id: "root-command", path: [] },
    ]);
  });
});

describe("snippet tree immutable mutations", () => {
  it("inserts at the root or in a deeply nested folder without changing the source", () => {
    const tree = fixture();
    const rootAddition = snippet("root-added", "Root added");
    const nestedAddition = snippet("diagnose", "Diagnose");

    const withRoot = insertSnippetNode(tree, null, rootAddition);
    const withNested = insertSnippetNode(tree, "production", nestedAddition);

    expect(withRoot.map((item) => item.id)).toEqual([
      "engineering",
      "personal",
      "root-command",
      "root-added",
    ]);
    expect(childrenForFolder(withNested, "production").map((item) => item.id)).toEqual([
      "rollback",
      "diagnose",
    ]);
    expect(findSnippetNode(tree, "root-added")).toBeNull();
    expect(findSnippetNode(tree, "diagnose")).toBeNull();
    expect(() => insertSnippetNode(tree, "missing", nestedAddition)).toThrow(
      "The destination folder no longer exists.",
    );
  });

  it("updates a nested node and preserves both the source and no-op identity", () => {
    const tree = fixture();
    const updated = updateSnippetNode(tree, "rollback", (node) => (
      node.type === "snippet"
        ? { ...node, name: "Emergency rollback", text: "rollback --force" }
        : node
    ));

    expect(findSnippetNode(updated, "rollback")).toMatchObject({
      name: "Emergency rollback",
      text: "rollback --force",
    });
    expect(findSnippetNode(tree, "rollback")).toMatchObject({
      name: "Rollback",
      text: "rollback --latest",
    });
    expect(updateSnippetNode(tree, "missing", (node) => node)).toBe(tree);
  });

  it("removes a nested subtree and reports the removed node", () => {
    const tree = fixture();
    const removal = removeSnippetNode(tree, "production");

    expect(removal.removed).toMatchObject({ id: "production", type: "folder" });
    expect(findSnippetNode(removal.tree, "production")).toBeNull();
    expect(findSnippetNode(removal.tree, "rollback")).toBeNull();
    expect(findSnippetNode(tree, "rollback")).not.toBeNull();

    const missing = removeSnippetNode(tree, "missing");
    expect(missing.removed).toBeNull();
    expect(missing.tree).toBe(tree);
  });

  it("reorders root and nested siblings and leaves boundary moves unchanged", () => {
    const tree = fixture();
    const rootReordered = reorderSnippetNode(tree, "personal", -1);
    const nestedReordered = reorderSnippetNode(tree, "deploy", -1);

    expect(rootReordered.map((item) => item.id)).toEqual([
      "personal",
      "engineering",
      "root-command",
    ]);
    expect(childrenForFolder(nestedReordered, "engineering").map((item) => item.id)).toEqual([
      "deploy",
      "test",
    ]);
    expect(reorderSnippetNode(tree, "engineering", -1)).toBe(tree);
    expect(reorderSnippetNode(tree, "missing", 1)).toBe(tree);
    expect(tree.map((item) => item.id)).toEqual([
      "engineering",
      "personal",
      "root-command",
    ]);
  });

  it("moves leaves and folders between parents while retaining their subtrees", () => {
    const tree = fixture();
    const movedLeaf = moveSnippetNode(tree, "test", "deploy");
    const movedFolder = moveSnippetNode(tree, "production", "personal");

    expect(childrenForFolder(movedLeaf, "engineering").map((item) => item.id)).toEqual([
      "deploy",
    ]);
    expect(childrenForFolder(movedLeaf, "deploy").map((item) => item.id)).toEqual([
      "staging",
      "production",
      "test",
    ]);
    expect(snippetFolderPath(movedFolder, "production").map((item) => item.id)).toEqual([
      "personal",
      "production",
    ]);
    expect(findSnippetNode(movedFolder, "rollback")).not.toBeNull();
    expect(snippetFolderPath(tree, "production").map((item) => item.id)).toEqual([
      "engineering",
      "deploy",
      "production",
    ]);
  });
});

describe("snippet move safety", () => {
  it("prevents moving a folder into itself or one of its descendants", () => {
    const tree = fixture();
    const engineering = findSnippetNode(tree, "engineering");
    const leaf = findSnippetNode(tree, "test");

    expect(engineering && [...descendantFolderIds(engineering)]).toEqual([
      "engineering",
      "deploy",
      "production",
    ]);
    expect(leaf && [...descendantFolderIds(leaf)]).toEqual([]);
    expect(() => moveSnippetNode(tree, "engineering", "engineering")).toThrow(
      "A folder cannot be moved inside itself.",
    );
    expect(() => moveSnippetNode(tree, "engineering", "production")).toThrow(
      "A folder cannot be moved inside itself.",
    );
    expect(() => moveSnippetNode(tree, "missing", null)).toThrow(
      "The item no longer exists.",
    );
    expect(() => moveSnippetNode(tree, "test", "missing")).toThrow(
      "The destination folder no longer exists.",
    );
    expect(findSnippetNode(tree, "test")).not.toBeNull();
  });

  it("offers only valid destination folders when a subtree is excluded", () => {
    const tree = fixture();
    const deploy = findSnippetNode(tree, "deploy");
    expect(deploy).not.toBeNull();

    const excludedIds = descendantFolderIds(deploy!);
    expect(folderOptions(tree, excludedIds)).toEqual([
      { id: null, label: "Library root", depth: 0 },
      { id: "engineering", label: "Engineering", depth: 1 },
      { id: "personal", label: "Personal", depth: 1 },
    ]);

    expect(folderOptions(tree)).toEqual([
      { id: null, label: "Library root", depth: 0 },
      { id: "engineering", label: "Engineering", depth: 1 },
      { id: "deploy", label: "Engineering / Deploy", depth: 2 },
      { id: "production", label: "Engineering / Deploy / Production", depth: 3 },
      { id: "personal", label: "Personal", depth: 1 },
    ]);
  });
});
