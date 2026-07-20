/**
 * Loading `.milk` presets from a web URL. The URL→fetch-target classification
 * ({@link resolvePresetUrl}) is a pure function (no network) so it can be unit
 * tested; {@link fetchMilkFromUrl} layers the actual `fetch` calls on top, and
 * {@link mapLimit} bounds the per-folder fetch concurrency.
 */

import type { PresetEntry } from "./Visualizer.ts";

/** Cap on how many presets a single folder URL will load (keeps it bounded). */
export const MAX_URL_PRESETS = 500;

/**
 * Map over `items` running at most `limit` async tasks at once; a task that
 * rejects is dropped (its slot omitted) so one failure doesn't sink the batch.
 *
 * @param items - The inputs to process.
 * @param limit - Maximum number of concurrently in-flight tasks.
 * @param fn - Async transform applied to each item.
 * @returns The successful results, in input order, failures omitted.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: (R | undefined)[] = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch {
        /* skip a single failed fetch; the rest still load */
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out.filter((v): v is R => v !== undefined);
}

/** How a pasted URL resolves: a GitHub folder, a single file, or unusable. */
export type PresetUrlTarget =
  | { kind: "folder"; apiUrl: string }
  | { kind: "file"; fileUrl: string; name: string }
  | { kind: "unsupported" };

/**
 * Normalize `candidate` and confirm it is still anchored under `prefix` -
 * URL normalization collapses dot-segments (`..`, `%2e%2e`, …), so an input
 * that tries to escape the intended path no longer matches the prefix.
 *
 * @param candidate - The URL assembled from user-supplied pieces.
 * @param prefix - The origin + path the result must remain under.
 * @returns The normalized URL, or `null` if it escaped the prefix.
 */
function anchoredUrl(candidate: string, prefix: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.href.startsWith(prefix) ? url.href : null;
}

/**
 * Parse a user-supplied direct link, accepting only http(s) URLs (rejects
 * `javascript:`, `data:`, relative paths, …).
 *
 * @param candidate - The URL the user pasted.
 * @returns The normalized URL, or `null` if unparsable or a non-web scheme.
 */
function httpUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:"
    ? url.href
    : null;
}

/**
 * Classify a preset URL into a fetch target - **pure, no network**. A GitHub
 * folder (`/tree/<ref>/<path>`) or a bare repo (`/<owner>/<repo>`, optionally a
 * `.git` clone URL) becomes a contents-API listing URL; a GitHub single-file
 * (`/blob/...`) or any direct `.milk` link becomes a file URL (the blob form
 * rewritten to the raw host); anything else is `unsupported`.
 *
 * @param input - The URL the user pasted.
 * @returns The resolved target descriptor.
 */
export function resolvePresetUrl(input: string): PresetUrlTarget {
  const url = input.trim();

  // GitHub folder: https://github.com/<owner>/<repo>/tree/<ref>/<path>
  const tree = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/,
  );
  if (tree) {
    const [, owner, repo, ref, path] = tree;
    const apiUrl = anchoredUrl(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref!)}`,
      `https://api.github.com/repos/${owner}/${repo}/contents/`,
    );
    return apiUrl ? { kind: "folder", apiUrl } : { kind: "unsupported" };
  }

  // GitHub single file (blob) → raw host; otherwise treat as a direct link
  const blob = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+\.milk)$/i,
  );
  const fileUrl = blob
    ? anchoredUrl(
        `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`,
        `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/`,
      )
    : httpUrl(url);
  if (fileUrl && /\.milk(\?.*)?$/i.test(fileUrl)) {
    const name = decodeURIComponent(
      (fileUrl.split("/").pop() ?? "preset").replace(/\.milk.*$/i, ""),
    );
    return { kind: "file", fileUrl, name };
  }

  // Bare GitHub repo, optionally a `.git` clone URL: list its root on the
  // default branch via the contents API (no `?ref` → repo default).
  const repo = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  if (repo) {
    const [, owner, name] = repo;
    const apiUrl = anchoredUrl(
      `https://api.github.com/repos/${owner}/${name}/contents/`,
      `https://api.github.com/repos/${owner}/${name}/contents/`,
    );
    return apiUrl ? { kind: "folder", apiUrl } : { kind: "unsupported" };
  }

  return { kind: "unsupported" };
}

/**
 * Resolve a web URL to `.milk` preset entries, performing the network fetches.
 * A GitHub folder is listed via the contents API and every `.milk` in it is
 * fetched (capped at {@link MAX_URL_PRESETS}, {@link mapLimit} concurrency); a
 * single file is fetched directly.
 *
 * @param input - A GitHub folder/blob URL or a direct `.milk` link.
 * @returns The fetched entries, the total `.milk` count found (so the caller
 *   can report truncation), and how many downloads failed.
 * @throws If the URL is unsupported or a required request fails.
 */
export async function fetchMilkFromUrl(
  input: string,
): Promise<{ entries: PresetEntry[]; total: number; failed: number }> {
  const target = resolvePresetUrl(input);

  if (target.kind === "folder") {
    const res = await fetch(target.apiUrl, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const items = (await res.json()) as {
      name: string;
      type: string;
      download_url: string | null;
    }[];
    if (!Array.isArray(items)) throw new Error("not a folder");
    const milk = items.filter(
      (i) => i.type === "file" && /\.milk$/i.test(i.name) && i.download_url,
    );
    const attempted = milk.slice(0, MAX_URL_PRESETS);
    const entries = await mapLimit(attempted, 8, async (i) => {
      const dl = await fetch(i.download_url!);
      if (!dl.ok) throw new Error(`HTTP ${dl.status}`);
      return {
        name: i.name.replace(/\.milk$/i, ""),
        source: await dl.text(),
      };
    });
    // mapLimit drops rejected slots; the difference is the failure count.
    return {
      entries,
      total: milk.length,
      failed: attempted.length - entries.length,
    };
  }

  if (target.kind === "file") {
    const res = await fetch(target.fileUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      entries: [{ name: target.name, source: await res.text() }],
      total: 1,
      failed: 0,
    };
  }

  throw new Error("use a raw .milk link or a GitHub folder URL");
}
