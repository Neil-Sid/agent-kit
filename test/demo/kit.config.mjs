export default {
  size: '960x540',
  ready: () => window.demo?.frames > 2,
  renderer: () => demo.renderer,
  scenes: () => [demo.scene],
  state: () => ({
    time: +demo.time.toFixed(4),
    knot: +demo.knot.rotation.y.toFixed(4),
    sparks: demo.sparks.length,
    spread: +demo.sparks.reduce((n, s) => n + s.position.x, 0).toFixed(3),
  }),
  scenarios: {
    idle: { warmup: 60, frames: 240 },
    sparks: { setup: () => demo.burst(40), drive: f => { if (f % 60 === 0) { demo.burst(20); return 'burst' } }, warmup: 30, frames: 300 },
  },
  budgets: { drawCalls: 600 },
  lint: { include: ['scene.js'] },
}
