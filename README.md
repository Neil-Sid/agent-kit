# agent-kit

Measure a three.js change instead of guessing, in plain text.

```
$ node ../agent-kit/bin/kit.mjs perf sparks
kit perf "sparks"  960x540  300 frames  state #f281edac
frame  fps 1892 fps  p50 0.5  p95 0.6  p99 0.9  max 1.1 ms  long 0
js     p50 0.3  p99 0.6 ms per frame   gc 0 ms/frame  alloc 51.7 KB/frame  heap drops 10
gpu    draw calls 479 (max 511)  triangles 12348
scene  466 objects  464/464 meshes visible (0 instanced, 0 transparent)  1 lights (0 shadow)  3 materials  2 programs
top cpu, project (self ms/frame)
    0.02  bob scene.js:45
...
budgets ok (1)

$ node ../agent-kit/bin/kit.mjs lint
measured: these ran in a perf scenario, per frame, costliest first (1)
  scene.js:47                         alloc-math       new Vector3()   [0.017 ms per frame in sparks: loop (scene.js) > bob (scene.js)]
```

An agent working on a three.js app can't see frame times, garbage collection or draw calls, and a single timing run on
a busy machine moves by 10-30 %. agent-kit runs the app in headless Chrome on the real GPU with a fixed 1/60 s clock and
a seeded `Math.random`, so a scenario plays out the same frames every run, and prints a short report the agent can act
on. Every command exits non-zero when something fails, so it also works as a check.

- `perf`: frame times, JS cost, GC, allocation, draw calls, a scene census, shader churn, GPU re-uploads and the top
  functions, compared against a saved baseline and checked against budgets. `--hitches` profiles just the worst frames.
- `lint`: static checks for per-frame allocation, GPU objects built mid-game and shader re-picks, ranked by what really
  ran in the last perf run.
- `verify` and `ab`: a commit or another folder against the working tree. Same state, same pixels (ignoring the app's
  own run-to-run noise), and faster or not.
- `determinism`: when two runs part ways, names the first `Math.random` call that went differently.
- `record` / `replay`: capture a play session and play it back headless to reproduce a bug or a hitch.
- `net`: what a first visit downloads, by host, and how many visits a hosting plan covers.
- `render`: tries a runtime render pass (static transform freezing, optional batching) and installs it only if it is
  measurably faster and every frame looks the same.

Works with WebGLRenderer and WebGPURenderer. Plain ES modules, no build step.

## Setup

Clone it next to your projects and install:

```bash
git clone https://github.com/Neil-Sid/agent-kit
```

```bash
cd agent-kit
```

```bash
npm install
```

Add a `kit.config.mjs` to your project. Its functions run inside the page, so the app needs to put what they read on
`window`:

```js
export default {
  ready: () => window.app?.started,      // the run starts the frame this is true
  renderer: () => app.renderer,
  scenes: () => [app.scene],
  state: () => ({ score: app.score }),   // compared between runs; keep it small
  scenarios: {
    idle: { warmup: 120, frames: 600 },
    fight: { setup: () => app.spawn(50), drive: f => { if (f % 60 === 0) app.fire() } },
  },
  budgets: { p99: 12, drawCalls: 900 },
}
```

Then, from the project folder:

```bash
node ../agent-kit/bin/kit.mjs perf idle --save
```

Make a change and run it again: every metric prints its difference from the saved baseline.

## Requirements

- Node 22.12 or newer.
- Chrome or Chromium. The kit looks in the default install location on Windows, macOS and Linux; elsewhere, set
  `KIT_CHROME` to the executable.
- The project folder is served as static files. For a bundled app, set `site: 'dist'` in the config and build first.
- `ab` needs the project to be a git repository. `render` needs `three` in an import map.

Built and used on Windows with a discrete GPU. Other platforms should work but haven't been tested much.

## Tests

```bash
npm test
```

Runs every command except `record`, `replay` and `ab` on the scene in `test/demo` and checks the reports. It needs
Chrome and a network connection (the demo loads three.js from jsDelivr).

## For agents

[AGENTS.md](AGENTS.md) is the full reference: every command and flag, the config keys, how the clock and probe work,
and the limits. It's written so it can go straight into an agent's context, for example by pointing to it from a
project's `CLAUDE.md` or `AGENTS.md`.

## License

MIT
