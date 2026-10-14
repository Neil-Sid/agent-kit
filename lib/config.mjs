// Defaults for whatever kit.config.mjs leaves out, so a project with no config at all still works. The probe finds the
// renderer, the scenes drawn lately and the camera on its own (probe.js, "zero config"); these just point at that.
export function withDefaults(config = {}) {
  return {
    ready: () => __kit.auto.ready(),
    renderer: () => __kit.auto.renderer(),
    scenes: () => __kit.auto.scenes(),
    state: () => __kit.auto.state(),
    systems: () => __kit.auto.systems(),
    ...config,
    scenarios: config.scenarios || { idle: { warmup: 120, frames: 600 } },
  }
}
