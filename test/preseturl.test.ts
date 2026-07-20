import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolvePresetUrl,
  mapLimit,
  fetchMilkFromUrl,
  MAX_URL_PRESETS,
} from "../src/app/presetUrl.ts";

describe("resolvePresetUrl (pure URL classification)", () => {
  it("maps a GitHub folder (tree) URL to a contents-API listing URL", () => {
    const t = resolvePresetUrl(
      "https://github.com/projectM-visualizer/presets-milkdrop-original/tree/master/Milkdrop-Original",
    );
    expect(t).toEqual({
      kind: "folder",
      apiUrl:
        "https://api.github.com/repos/projectM-visualizer/presets-milkdrop-original/contents/Milkdrop-Original?ref=master",
    });
  });

  it("rewrites a GitHub single-file (blob) URL to the raw host and derives a name", () => {
    const t = resolvePresetUrl(
      "https://github.com/o/r/blob/main/dir/Cool%20Preset.milk",
    );
    expect(t).toEqual({
      kind: "file",
      fileUrl:
        "https://raw.githubusercontent.com/o/r/main/dir/Cool%20Preset.milk",
      name: "Cool Preset", // %20 decoded, .milk stripped
    });
  });

  it("accepts a direct .milk link (incl. a query string) and trims whitespace", () => {
    expect(resolvePresetUrl("  https://x.test/a/b/Foo.milk  ")).toMatchObject({
      kind: "file",
      name: "Foo",
    });
    expect(resolvePresetUrl("https://x.test/Bar.MILK?token=1")).toMatchObject({
      kind: "file",
      name: "Bar",
    });
  });

  it("maps a bare GitHub repo URL (and a .git clone URL) to a root contents listing", () => {
    expect(resolvePresetUrl("https://github.com/o/r")).toEqual({
      kind: "folder",
      apiUrl: "https://api.github.com/repos/o/r/contents/",
    });
    expect(resolvePresetUrl("https://github.com/o/r/")).toMatchObject({
      kind: "folder",
      apiUrl: "https://api.github.com/repos/o/r/contents/",
    });
    expect(resolvePresetUrl("https://github.com/o/r.git")).toMatchObject({
      kind: "folder",
      apiUrl: "https://api.github.com/repos/o/r/contents/",
    });
  });

  it("rejects anything that is neither a GitHub URL nor a .milk link", () => {
    expect(resolvePresetUrl("https://example.com/notes.txt").kind).toBe(
      "unsupported",
    );
    expect(resolvePresetUrl("https://example.com").kind).toBe("unsupported");
  });
});

describe("mapLimit (bounded concurrency)", () => {
  it("processes every item and preserves input order", async () => {
    const out = await mapLimit([1, 2, 3, 4], 2, (n) => Promise.resolve(n * 10));
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never runs more than `limit` tasks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 0;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("drops failures but keeps the rest", async () => {
    const out = await mapLimit([1, 2, 3, 4], 4, (n) =>
      n % 2 === 0 ? Promise.reject(new Error("nope")) : Promise.resolve(n),
    );
    expect(out).toEqual([1, 3]);
  });
});

describe("fetchMilkFromUrl (network layer, stubbed fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches a single direct .milk file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("[preset00]\n", { status: 200 })),
      ),
    );
    const { entries, total } = await fetchMilkFromUrl(
      "https://x.test/My%20Preset.milk",
    );
    expect(total).toBe(1);
    expect(entries).toEqual([{ name: "My Preset", source: "[preset00]\n" }]);
  });

  it("lists a GitHub folder, fetches each .milk, and reports the total found", async () => {
    const listing = [
      { name: "a.milk", type: "file", download_url: "https://raw/a.milk" },
      { name: "b.milk", type: "file", download_url: "https://raw/b.milk" },
      {
        name: "readme.txt",
        type: "file",
        download_url: "https://raw/readme.txt",
      },
      { name: "sub", type: "dir", download_url: null },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (new URL(url).hostname === "api.github.com")
          return Promise.resolve(
            new Response(JSON.stringify(listing), { status: 200 }),
          );
        return Promise.resolve(new Response(`src of ${url}`, { status: 200 }));
      }),
    );
    const { entries, total, failed } = await fetchMilkFromUrl(
      "https://github.com/o/r/tree/main/dir",
    );
    expect(total).toBe(2); // only the two .milk files
    expect(failed).toBe(0);
    expect(entries.map((e) => e.name).sort()).toEqual(["a", "b"]);
  });

  it("counts per-file download failures instead of silently dropping them", async () => {
    const listing = [
      { name: "good.milk", type: "file", download_url: "https://raw/good" },
      { name: "gone.milk", type: "file", download_url: "https://raw/gone" },
      { name: "boom.milk", type: "file", download_url: "https://raw/boom" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (new URL(url).hostname === "api.github.com")
          return Promise.resolve(
            new Response(JSON.stringify(listing), { status: 200 }),
          );
        if (url.endsWith("gone"))
          return Promise.resolve(new Response("", { status: 404 }));
        if (url.endsWith("boom"))
          return Promise.reject(new Error("network down"));
        return Promise.resolve(new Response("[preset00]", { status: 200 }));
      }),
    );
    const { entries, total, failed } = await fetchMilkFromUrl(
      "https://github.com/o/r/tree/main/dir",
    );
    expect(total).toBe(3);
    expect(failed).toBe(2); // the 404 and the network error
    expect(entries.map((e) => e.name)).toEqual(["good"]);
  });

  it("throws on an unsupported URL and on a failed request", async () => {
    await expect(
      fetchMilkFromUrl("https://example.com/x.txt"),
    ).rejects.toThrow();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 404 }))),
    );
    await expect(fetchMilkFromUrl("https://x.test/a.milk")).rejects.toThrow(
      /404/,
    );
  });

  it("caps a huge folder at MAX_URL_PRESETS", async () => {
    const listing = Array.from({ length: MAX_URL_PRESETS + 25 }, (_, i) => ({
      name: `p${i}.milk`,
      type: "file",
      download_url: `https://raw/p${i}.milk`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new URL(url).hostname === "api.github.com"
            ? new Response(JSON.stringify(listing), { status: 200 })
            : new Response("x", { status: 200 }),
        ),
      ),
    );
    const { entries, total } = await fetchMilkFromUrl(
      "https://github.com/o/r/tree/main/big",
    );
    expect(total).toBe(MAX_URL_PRESETS + 25);
    expect(entries.length).toBe(MAX_URL_PRESETS);
  });
});
