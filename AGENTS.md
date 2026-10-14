# agent-kit

Text-first tools for three.js projects. Every command prints a short report, so you can measure a change instead of guessing,
and exits non-zero when something fails. Run them from the project folder (or pass `--dir <project>`):

```
node ../agent-kit/bin/kit.mjs <command>
```

A `kit.config.mjs` (below) is optional. Without one the kit finds the renderer, scenes and camera itself and runs an
`idle` scenario; `kit init` writes a starter config naming what it found. Output goes to `<project>/.kit/`.

| command | what it answers | time |
|---|---|---|
| `kit init [--force]` | Sets a project up: finds the renderer, scenes and camera, writes `kit.config.mjs` with the page globals that lead to them, adds `.kit/` to `.gitignore`, and saves a first `perf idle` baseline. A bundled app (vite, `bun build`, ...) is built and served from its output folder. | ~20 s |
| `kit check [scenario...] [--save] [--strict]` | Is this change done? Every scenario once, one verdict line each. Budgets, page errors and counters that rose since the baseline fail; slower frame times only warn. Lint runs last. `--save` accepts the new numbers. | ~30 s per scenario |
| `kit lint` | Which per-frame code allocates, builds GPU objects or forces shader re-picks. Findings are ranked by what really ran in the last perf runs. | < 1 s |
| `kit perf [scenario]` | Frame times, JS cost, GC, draw calls, the scene census, shader churn, the top project and library functions, which of your functions the library cost ran under, and budgets, all compared against the baseline. | ~30 s |
| `kit perf <scenario> --hitches [n]` | What the n worst frames were made of. Each is re-run in a fresh page (same frames, deterministic) with the profiler on for just those frames. `drive(f)` can return a label ("go to Sirius") to name the action before a hitch. | ~30 s per hitch |
| `kit verify <scenario...> [--ref HEAD\|<folder>] [--runs 3]` | Is my rewrite the same game, and is it faster? The reference (a commit, or another folder such as an untouched copy) runs twice and the working tree once: `config.state()` compared every 60 frames, screenshots diffed ignoring whatever differs between the two reference runs, new console errors. Then alternating timed runs; a speed change counts only when the two sides' ranges don't overlap. Ends with one verdict line and exits 1 if behavior changed. | ~3 min per scenario |
| `kit render <scenario...> [--batch] [--apply] \| --revert` | Tries the runtime render pass (`lib/render.js`) the same way: without vs with it on one folder. `--apply` installs it (`kit-render.js` + a script tag after the import map) only if every frame checked out the same and it was faster. `kit perf <scenario> --render` profiles with it on. | ~4 min per scenario |
| `kit ab <scenario...> [--ref HEAD] [--shots f1,f2]` | Did my change help or hurt? Runs the scenarios on a commit and on your working tree with the same config, shows metrics side by side, and screenshots the same frames in both, with a pixel diff and a diff image (changes in red) in `.kit/ab/`. | ~45 s per scenario |
| `kit net [scenario] [--site dist]` | What a first visit downloads, by host and phase. Lists the requests that reach your own host (raw and gzip sizes), flags URLs requested twice and 404s, and with `config.hosting` gives the visits per month your plan covers. | ~15 s |
| `kit determinism <scenario>` | Whether two runs simulate the same frames. If not, it names the first `Math.random` call that went differently. | a few min |
| `kit record <name>` | Records a play session (input and frame times) in a visible window. Press F8 to save. | as long as you play |
| `kit replay <name> [--perf] [--shot f]` | Plays a recording back headless, reports where the game state departs from the recording, the worst frames, and screenshots. | ~30 s |

## The loop

1. `kit perf <scenario> --save` stores a baseline in `.kit/<scenario>.baseline.json`.
2. Make one change.
3. Run `kit perf <scenario>` again. Every metric prints its +/- against the baseline. If `state #...` matches the baseline,
   both runs simulated the same frames, so the comparison is like for like.
4. Run `kit lint` for the code-level view. Its "measured" section only lists functions that the perf profile saw running.
5. Before calling the change done, run `kit check`. It fails if a counter rose against the baseline in any scenario;
   if the rise is intended (a new feature draws more), `kit check --save` makes the new numbers the baseline.

Frame-time numbers move by 10-30 % when other programs load the GPU or CPU. For a decision that matters, use `--runs 3`,
which takes the median of fresh pages. Counters such as draw calls, allocation, churn, programs and the scene census
don't depend on machine load, so trust those first.

## How it works

`lib/probe.js` loads before the page's own scripts and takes over `requestAnimationFrame`:

- **Fixed clock.** The game gets 1/60 s per frame whatever the real gap, while the real gap is still timed. A scenario
  therefore plays out the same each run, and the cost is still measured honestly.
- **Seeded `Math.random`.** Timers (`setTimeout`, `setInterval`, `requestIdleCallback`) move onto the game clock once the
  page is ready.
- **Freeze at ready.** The game is frozen the moment `config.ready()` is true. Setup runs while it's frozen, and
  `runTo(n)` stops at exactly frame n.
- **Scene diagnosis.** Every material is watched for three.js shader re-picks (`getParameters` each frame). The causes
  it reports are a `needsUpdate` or version bump, a change in the light setup, or a colour-space flip. A transparent
  `DoubleSide` material hits this twice per frame unless it has `forceSinglePass`.

- **Game clock for time sources.** In fixed and replay modes, `performance.now()` (and so `THREE.Clock`) returns the
  frame's game time plus the real time elapsed in the frame, so ms budgets still work. `Date.now()` returns a fixed
  epoch (`config.epoch`, default 2026-01-01) plus game time.
- **GPU uploads.** The `upload` line lists geometry attributes and textures whose version changes on most frames. On
  WebGPU, the `queue` line wraps `GPUQueue.writeBuffer` and shows calls, KB and ms per frame by three.js function and
  project caller. In one WebGPU app that is how a 49 MB/frame re-upload showed up (`DynamicDrawUsage` attributes are re-sent
  on every draw under WebGPURenderer).

- **Zero config.** three.js announces every renderer, scene and loader it builds to `window.__THREE_DEVTOOLS__` (the
  hook its devtools extension uses), and every render calls `scene.onBeforeRender(renderer, scene, camera)`. The probe
  listens to both, so whatever the config leaves out has a default:
  - `renderer`: the one drawing the main scene.
  - `scenes`: every scene drawn in the last 60 frames, biggest first (one-object post-processing quads are left out).
  - `ready`: a scene is being drawn and nothing has loaded for a second (no three.js loads or fetches pending, no
    resource finished, no new geometry, texture or shader program). An app that streams forever starts 10 s after its
    first frame instead.
  - `state`: the object count, a hash of every position, and the main camera's pose.
  - `systems`: time inside `renderer.render` vs the rest of the frame's JS.
  - `scenarios`: `idle: { warmup: 120, frames: 600 }`.

  A page that waits for a click before it draws never gets ready; the timeout message says so. Set `query` or `ready`
  for it.

Works with both WebGLRenderer and WebGPURenderer. Chrome is launched with `--enable-unsafe-webgpu`. The kit finds Chrome in
its default install location on Windows, macOS and Linux; set `KIT_CHROME` to use another Chrome or Chromium. The project
folder (or `config.serve`) is served as static files, so a bundled app needs a build first.

Profiles come from Chrome DevTools: CPU self time and sampled allocation per `function file:line`. Rows for libraries
(CDN, `node_modules`, vendor folders) are listed separately, because you usually can't fix them, only call them less.
The "library cpu / alloc under your functions" sections say which calls of yours to make less often: each library sample
goes to the nearest project function up its stack, e.g. `2.19  render js/core/post.js:100  refreshUniformsCommon 0.15,
updateMatrixWorld 0.15, setProgram 0.14`. Code that resumes after an `await` has no caller on its stack and shows as
"(none of your functions above it)". The probe's own frames are left out of every list.

## kit.config.mjs (in the project root)

Every key is optional; the probe's defaults (zero config, above) fill in what's left out.

```js
export default {
  query: '?dev&autostart',                       // page URL query
  size: '1920x1080',
  serve: 'dist',                                 // folder every command serves (a bundled app's build output)
  ready: () => window.game?.state === 'playing', // runs in the page; freeze point
  renderer: () => game.renderer,
  scenes: () => [game.scene],                    // for the census and shader churn
  systems: () => perf.systems(),                 // { name: ms/frame } split
  state: () => ({ ... }),                        // compared for determinism and replays; keep it small
  longMs: 16.7,                                  // a frame over this counts as long
  scenarios: {
    name: { setup: () => {...}, drive: f => {...}, warmup: 120, frames: 600, realtime: false },
  },
  budgets: { p99: 12, drawCalls: 900, allocKB: 64, gcMs: 0.5, geometries: 0 },   // number = ceiling, { min } = floor
  lint: { include: ['js'], roots: ['requestAnimationFrame', 'setAnimationLoop'] }, // fn(cb): cb runs every frame
  site: 'dist',                                  // optional: the folder your host serves; kit net measures it
  build: 'npm run build',                        // optional: kit ab --site dist runs it on both sides first
  hosting: { requests: 10e6, bytes: 1e12 },      // optional: your plan's monthly allowance, for kit net
  check: { tolerance: { drawCalls: 0.05 } },     // optional: allow a bigger rise in kit check (a fraction of the baseline)
}
```

Every function in the config runs inside the page, so it can only see page globals. `setup` runs while the game is
frozen, so it must not wait for frames. `drive(f)` runs before each frame, with `f` counted from the start of the run.

## check notes

- Each scenario runs once, as `kit perf` would, and gets one line: `ok`, `new` (no baseline yet, so this run became
  it), `warn` or `FAIL`, with the reasons indented below it.
- Fails: a budget, a page error, a `drive` error, or a counter that rose since the baseline. The counters are draw
  calls and triangles (1 % allowed), shader programs (none), allocation (10 % and 2 KB, as it is sampled), and
  geometries, textures and programs created during the run (none). Machine load doesn't move these, so a rise is the
  code. An app with a time-budgeted stream does move them; give it `check.tolerance`.
- Warns: frame p99 or JS p50 25 % and 0.5 ms slower than the baseline. Confirm with `kit perf <scenario> --runs 3`.
- "(plays out differently from the baseline)" means the end state differs, so the run isn't like for like.
- A counter that fell is listed as better; `kit check --save` keeps the new numbers so the next rise is caught.
- `--strict` also fails on lint findings that ran or are reachable from per-frame code.

## ab notes

- The commit is exported once per hash into `.kit/ab/<hash>/`, using git's own files only. Folders that git ignores
  (asset packs, for example) are missing there, so a project that serves ignored files can't be compared this way.
  `node_modules` is linked in for build steps.
- Both sides use the working tree's `kit.config.mjs`, so scenarios that call newly added page functions fail on the
  old side.
- Read the diff image, not just the percentage. Red dots scattered over a star field are streaming noise. A red planet,
  panel or edge is a real change.

## verify notes

- Use it after a refactor that should change speed and nothing else: different data structures, a reshaped loop,
  a cache. `--ref ../original` compares against a folder, for projects without git or against an untouched copy.
- Many apps aren't fully repeatable (streamed content on a time budget, animation phases), so the reference runs
  twice. Pixels that differ between those two runs, widened by 2 px and by whole tiles where the difference is
  dense, don't count; the diff image shows them in blue and real changes in red. A frame where more than 25% is
  noise gets "CAN'T JUDGE" instead of a verdict. State checkpoints are compared up to the first one where the two
  reference runs already disagree.
- The speed verdict needs at least 2 runs per side; 3-4 is better.

## Render pass (`kit render`)

`lib/render.js` is plain runtime code, injected for a trial and written into the project by `--apply`. It changes
nothing game code can see: positions, `visible`, layers and raycasts all behave as before.

- **Static transforms.** An object whose position, rotation, scale and children stay the same for 90 renders gets
  `matrixAutoUpdate = false`, and a subtree that is entirely static is skipped by `updateMatrixWorld`. Every render
  first compares each static object with its snapshot; any change restores it and its parents at once. The object
  also gets its own `updateMatrixWorld`/`updateWorldMatrix` that do the same check, so `getWorldPosition()` and
  explicit updates see a moved object, and `copy()`/`clone()` of a static object get `matrixAutoUpdate` back.
- **Batching (`--batch`, off by default).** Static opaque meshes that share a material become one `BatchedMesh`.
  The originals stay in the scene; an empty bounding sphere makes the renderer's frustum test skip them. A member
  that moves, changes material or geometry, or leaves the scene drops back to drawing itself.
- What it gives depends on the scene. On a zombie shooter (5,100 static objects of 5,600) the freeze removes three's
  0.43 ms of `updateMatrixWorld` but its own check costs 0.26 ms, a net 0.17 ms that is below the run-to-run noise.
  Batching saved only 62 of 430 draw calls there (almost every mesh has its own geometry, and most static meshes
  are culled anyway) and cost more than it saved. It pays off when a scene draws many static meshes that share
  materials.

## Lint notes

- Silence a finding with `// kit-ignore` or `// kit-ignore rule-name` on the line or the line above.
- The call graph over-approximates: a method call reaches every project method with that name (up to 4 of them).
  The "static" section may include event-only code. The "measured" section is the one to trust.
- `on events` findings are GPU objects built mid-game, which stall a frame the first time. Build them during load
  (prewarm) or keep a pool.

## Making a game deterministic

Run `kit determinism <scenario>`. Two runs part when code takes a different path from wall-clock time,
for example:

- `performance.now()` budgets such as "do jobs for 3 ms"
- `Date.now()`
- audio `onended` callbacks
- async loads that finish at different times

The report shows the last random call both runs shared and the call where they split. The cause sits between those
two. Fix it by tying that code to the frame `dt` or a frame counter.
