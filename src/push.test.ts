import { expect, test } from "bun:test";
import { classifySliceStatus } from "./push";
import type { Correspondence } from "./store";

function correspondence(contentHash: string): Correspondence {
  return {
    branch: "feature",
    sliceSignature: "sig",
    sliceBranch: "drip/feature/slice0",
    prNumber: 1,
    prUrl: "https://example.com/pull/1",
    contentHash,
    commitSha: "deadbeef",
  };
}

test("no correspondence, real mode -> created", () => {
  expect(classifySliceStatus({ existing: null, squashMerged: false, contentHash: "abc", dryRun: false })).toBe("created");
});

test("no correspondence, dry-run -> dry-run (not created, since nothing's pushed yet)", () => {
  expect(classifySliceStatus({ existing: null, squashMerged: false, contentHash: "abc", dryRun: true })).toBe("dry-run");
});

test("existing correspondence, content changed, real mode -> updated", () => {
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: false, contentHash: "new", dryRun: false })).toBe("updated");
});

test("existing correspondence, content changed, dry-run -> dry-run", () => {
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: false, contentHash: "new", dryRun: true })).toBe("dry-run");
});

test("existing correspondence, content unchanged -> unchanged, regardless of dry-run", () => {
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: false, contentHash: "same", dryRun: false })).toBe("unchanged");
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: false, contentHash: "same", dryRun: true })).toBe("unchanged");
});

test("squash-merged wins over everything else, regardless of correspondence state or dry-run", () => {
  expect(classifySliceStatus({ existing: null, squashMerged: true, contentHash: "abc", dryRun: false })).toBe("squash-merged");
  expect(classifySliceStatus({ existing: correspondence("same"), squashMerged: true, contentHash: "same", dryRun: false })).toBe("squash-merged");
  expect(classifySliceStatus({ existing: correspondence("old"), squashMerged: true, contentHash: "new", dryRun: true })).toBe("squash-merged");
});
