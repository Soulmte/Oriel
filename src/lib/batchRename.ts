import type { EntryDto } from "@oriel/shared";

/**
 * Batch rename is expressed as a small recipe instead of a mode switch:
 * replace text, then re-case, then add a number or an affix. Each step is
 * optional, the order is fixed, and the preview shows exactly what the server
 * would be asked to do. Keeping this pure makes it testable without a window.
 */
export interface BatchRenameOptions {
  find: string;
  replace: string;
  caseSensitive: boolean;
  useRegex: boolean;
  casing: "keep" | "lower" | "upper" | "title" | "kebab" | "snake";
  affix: string;
  affixPosition: "prefix" | "suffix";
  numbering: boolean;
  start: number;
  step: number;
  digits: number;
  numberPosition: "prefix" | "suffix";
  includeExtension: boolean;
}

export const DEFAULT_BATCH_RENAME: BatchRenameOptions = {
  find: "",
  replace: "",
  caseSensitive: false,
  useRegex: false,
  casing: "keep",
  affix: "",
  affixPosition: "suffix",
  numbering: false,
  start: 1,
  step: 1,
  digits: 2,
  numberPosition: "suffix",
  includeExtension: false,
};

export interface BatchRenameRow {
  entry: EntryDto;
  /** The name as it stands today. */
  name: string;
  /** What it will be called; equals `name` when nothing applies. */
  next: string;
  /** Why this row cannot be applied, if it cannot. */
  problem: string | null;
  changed: boolean;
}

export interface BatchRenamePlan {
  rows: BatchRenameRow[];
  changed: number;
  conflicts: number;
  /** First invalid regular expression, if the pattern does not compile. */
  patternError: string | null;
}

const INVALID_CHARS = /[\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Splits `report.final.pdf` into `report.final` + `.pdf`. */
export function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

function applyCase(value: string, casing: BatchRenameOptions["casing"]): string {
  switch (casing) {
    case "lower":
      return value.toLowerCase();
    case "upper":
      return value.toUpperCase();
    case "title":
      return value
        .split(/(\s+|_|-)/)
        .map((part) => (part.trim() ? part[0].toUpperCase() + part.slice(1) : part))
        .join("");
    case "kebab":
      return value
        .replace(/\s+/g, "-")
        .replace(/_+/g, "-")
        .replace(/-+/g, "-");
    case "snake":
      return value
        .replace(/\s+/g, "_")
        .replace(/-+/g, "_")
        .replace(/_+/g, "_");
    default:
      return value;
  }
}

export function planBatchRename(
  entries: EntryDto[],
  options: BatchRenameOptions,
  /** Names already in the folder, used to flag collisions. */
  siblingNames: Iterable<string> = [],
): BatchRenamePlan {
  const siblings = new Set<string>();
  for (const name of siblingNames) siblings.add(name.toLowerCase());

  let pattern: RegExp | null = null;
  let patternError: string | null = null;
  if (options.find && options.useRegex) {
    try {
      pattern = new RegExp(options.find, options.caseSensitive ? "g" : "gi");
    } catch (error) {
      patternError = error instanceof Error ? error.message : String(error);
    }
  }

  const rows: BatchRenameRow[] = entries.map((entry, index) => {
    const { stem, extension } = splitExtension(entry.name);
    let target = options.includeExtension ? entry.name : stem;
    const tail = options.includeExtension ? "" : extension;

    if (patternError) {
      return { entry, name: entry.name, next: entry.name, problem: "正则表达式无法解析", changed: false };
    }

    if (options.find) {
      if (pattern) {
        pattern.lastIndex = 0;
        target = target.replace(pattern, options.replace);
      } else {
        const find = options.caseSensitive ? options.find : options.find.toLowerCase();
        const haystack = options.caseSensitive ? target : target.toLowerCase();
        let out = "";
        let cursor = 0;
        for (;;) {
          const at = haystack.indexOf(find, cursor);
          if (at === -1) break;
          out += target.slice(cursor, at) + options.replace;
          cursor = at + find.length;
        }
        target = out + target.slice(cursor);
      }
    }

    target = applyCase(target, options.casing);

    const number = options.numbering
      ? String(options.start + index * options.step).padStart(options.digits, "0")
      : "";
    const affix = options.affix;

    if (number) {
      target =
        options.numberPosition === "prefix" ? number + target : target + number;
    }
    if (affix) {
      target = options.affixPosition === "prefix" ? affix + target : target + affix;
    }

    const next = (target + tail).trim();
    const problem = validate(next);
    return {
      entry,
      name: entry.name,
      next,
      problem,
      changed: next !== entry.name,
    };
  });

  // Two rows that land on the same name (or on a file that is not part of the
  // batch) would make the server refuse the whole run: say so up front.
  const claimed = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (!row.changed) continue;
    const key = row.next.toLowerCase();
    const previous = claimed.get(key);
    if (previous !== undefined) {
      row.problem = `与第 ${previous + 1} 项重名`;
    } else {
      claimed.set(key, index);
    }
  }

  const movedAway = new Set(
    rows.filter((row) => row.changed).map((row) => row.name.toLowerCase()),
  );
  for (const row of rows) {
    if (!row.changed || row.problem) continue;
    const key = row.next.toLowerCase();
    if (siblings.has(key) && !movedAway.has(key)) {
      row.problem = "已存在同名项目";
    }
  }

  const changed = rows.filter((row) => row.changed).length;
  const conflicts = rows.filter((row) => row.problem !== null).length;
  return { rows, changed, conflicts, patternError };
}

/** Windows' own naming rules; the server repeats these, this is for the preview. */
export function validate(name: string): string | null {
  if (!name) return "名称不能为空";
  if (name === "." || name === "..") return "名称不能为空";
  if (INVALID_CHARS.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  if (/[. ]$/.test(name)) return "名称不能以空格或句点结尾";
  if (RESERVED.test(name)) return "该名称是 Windows 保留名称";
  if (name.length > 255) return "名称过长";
  return null;
}

/** Turns a plan into the request body the server expects. */
export function toRequestItems(
  plan: BatchRenamePlan,
): Array<{ path: string; name: string }> {
  return plan.rows
    .filter((row) => row.changed && !row.problem)
    .map((row) => ({ path: row.entry.path, name: row.next }));
}
