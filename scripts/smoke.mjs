// Headless smoke test: boots the dev server separately, loads the app in Chrome
// with software WebGL2 + a fake audio device, and verifies the canvas renders a
// non-trivial (non-black) frame. Saves a screenshot to /tmp/milkslop.png.
//
// Usage: `npm run dev` in one terminal, then `node scripts/smoke.mjs`.
import { chromium } from "playwright";

const URL = process.env.URL || "http://localhost:5173/";
const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon"))
    errors.push("CONSOLE: " + m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(URL, { waitUntil: "load" });
await page.click("#start").catch(() => {});
await page.waitForTimeout(2500);

const stats = await page.evaluate(
  () =>
    new Promise((res) => {
      requestAnimationFrame(() => {
        const c = document.getElementById("stage");
        const gl = c.getContext("webgl2");
        const w = c.width,
          h = c.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let nonblack = 0,
          sum = 0,
          mx = 0;
        for (let i = 0; i < px.length; i += 4) {
          const v = px[i] + px[i + 1] + px[i + 2];
          if (v > 10) nonblack++;
          sum += v;
          if (v > mx) mx = v;
        }
        res({
          w,
          h,
          nonblackPct: +((100 * nonblack) / (w * h)).toFixed(1),
          avg: +(sum / (w * h)).toFixed(1),
          max: mx,
        });
      });
    }),
);

await page.screenshot({ path: "/tmp/milkslop.png" });
await browser.close();

console.log("stats:", JSON.stringify(stats));
console.log("errors:", errors.length ? errors.join(" | ") : "none");
const ok = stats.nonblackPct > 5 && errors.length === 0;
console.log(ok ? "SMOKE OK" : "SMOKE FAIL");
process.exit(ok ? 0 : 1);
