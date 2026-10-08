// A small scene for the kit's tests: 441 bobbing crates, a spinning knot, and sparks from burst(n).
import * as THREE from 'three'

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(1)
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x101418)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 200)
camera.position.set(0, 14, 26)
camera.lookAt(0, 0, 0)
scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2))

const box = new THREE.BoxGeometry(0.8, 0.8, 0.8)
const crateMaterial = new THREE.MeshStandardMaterial({ color: 0x8aa0b4 })
const crates = []
for (let x = -10; x <= 10; x++) for (let z = -10; z <= 10; z++) {
  const crate = new THREE.Mesh(box, crateMaterial)
  crate.position.set(x, 0, z)
  scene.add(crate)
  crates.push(crate)
}

const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(2, 0.6, 128, 16), new THREE.MeshStandardMaterial({ color: 0xe0a050 }))
knot.position.y = 4
scene.add(knot)

const sparkGeometry = new THREE.SphereGeometry(0.15, 8, 6)
const sparkMaterial = new THREE.MeshBasicMaterial({ color: 0xffd080 })
const sparks = []

function burst(n) {
  for (let i = 0; i < n; i++) {
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial)
    spark.position.copy(knot.position)
    spark.userData.v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).multiplyScalar(12)
    scene.add(spark)
    sparks.push(spark)
  }
}

// Allocates a Vector3 per crate per frame on purpose, so kit lint has something to find.
function bob(t) {
  for (const crate of crates) {
    const target = new THREE.Vector3(crate.position.x, Math.sin(t * 2 + crate.position.x) * 0.2, crate.position.z)
    crate.position.lerp(target, 0.1)
  }
}

function fall(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i]
    s.userData.v.y -= 9.8 * dt
    s.position.addScaledVector(s.userData.v, dt)
    if (s.position.y < 0) { scene.remove(s); sparks.splice(i, 1) }
  }
}

const demo = window.demo = { renderer, scene, sparks, burst, time: 0, frames: 0, knot }
let last = 0
function loop(now) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  demo.time += dt
  demo.frames++
  knot.rotation.y += dt
  bob(demo.time)
  fall(dt)
  renderer.render(scene, camera)
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)
