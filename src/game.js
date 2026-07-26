import * as THREE from 'three'
import {joinRoom as joinNostr} from 'trystero/nostr'
import {joinRoom as joinMqtt} from '@trystero-p2p/mqtt'

// ============================================================
//  Brooktown — a Brookhaven-style mini town you play in the
//  browser with friends. Multiplayer is peer-to-peer (trystero).
// ============================================================

const APP_ID = 'cucumbertown-v1'
const params = new URLSearchParams(location.search)
const TEST_MODE = params.get('test') === '1'
const DEV = TEST_MODE || params.get('dev') === '1'

// Matchmaking servers. Trystero would otherwise pick 5 relays at random from a
// long list of mostly-dead ones, which is why players never found each other.
// These are the big, well-maintained public nostr relays, pinned explicitly.
const NOSTR_RELAYS = params.get('relay') ? [params.get('relay')] : [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://offchain.pub',
  'wss://relay.snort.social',
  'wss://nostr.mom',
  'wss://relay.mostr.pub',
]
// A second, completely different network, in case nostr is blocked on someone's wifi
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]
// stable id for me, shared across both networks so friends are never duplicated
const MY_ID = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const SHIRT_COLORS = [0xe53e3e, 0x3182ce, 0x38a169, 0xd69e2e, 0x805ad5, 0xdd6b20, 0x319795, 0xd53f8c]
const SKIN = 0xf5cd30      // classic Roblox yellow
const PANTS = 0x2f5d8c     // blue jeans

// ---------- renderer / scene ----------
const canvas = document.getElementById('game')
const renderer = new THREE.WebGLRenderer({canvas, antialias: true})
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 90, 220)

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 500)

// on a tall phone screen a 60° vertical view crops the world to a slit —
// widen the lens so you can still see what's around you
function fitCamera() {
  const aspect = innerWidth / innerHeight
  camera.aspect = aspect
  camera.fov = aspect < 1 ? Math.min(80, 60 / Math.max(0.5, aspect)) : 60
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
}
addEventListener('resize', fitCamera)
addEventListener('orientationchange', () => setTimeout(fitCamera, 200))
fitCamera()

// ---------- lights ----------
scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x6a8f5f, 1.1))
const sun = new THREE.DirectionalLight(0xfff2cc, 1.4)
sun.position.set(60, 90, 40)
sun.castShadow = true
sun.shadow.mapSize.set(2048, 2048)
sun.shadow.camera.left = -120
sun.shadow.camera.right = 120
sun.shadow.camera.top = 120
sun.shadow.camera.bottom = -120
sun.shadow.camera.far = 300
scene.add(sun)

// ---------- helpers ----------
const box = (w, h, d, color, x = 0, y = 0, z = 0, opts = {}) => {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({color, ...opts})
  )
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

const colliders = [] // {minX,maxX,minZ,maxZ}
// things you can press E on: {kind:'sit'|'sleep'|'drive', label, x, z, yaw, bodyY, range}
const spots = []
const addCollider = (cx, cz, w, d, pad = 0.2) => {
  colliders.push({
    minX: cx - w / 2 - pad, maxX: cx + w / 2 + pad,
    minZ: cz - d / 2 - pad, maxZ: cz + d / 2 + pad,
  })
}

// seeded random so every player sees the SAME town
let seed = 1337
const rand = () => {
  seed = (seed * 16807) % 2147483647
  return (seed - 1) / 2147483646
}
const pick = arr => arr[Math.floor(rand() * arr.length)]

// ============================================================
//  THE TOWN
// ============================================================

// grass
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(320, 320),
  new THREE.MeshLambertMaterial({color: 0x7bb661})
)
ground.rotation.x = -Math.PI / 2
ground.receiveShadow = true
scene.add(ground)

// roads: two vertical + two horizontal strips at ±25
const ROAD_W = 9
const roadMat = new THREE.MeshLambertMaterial({color: 0x4a4a52})
const lineMat = new THREE.MeshLambertMaterial({color: 0xf6e05e})
for (const p of [-25, 25]) {
  const rv = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W, 0.05, 160), roadMat)
  rv.position.set(p, 0.025, 0); rv.receiveShadow = true; scene.add(rv)
  const rh = new THREE.Mesh(new THREE.BoxGeometry(160, 0.05, ROAD_W), roadMat)
  rh.position.set(0, 0.025, p); rh.receiveShadow = true; scene.add(rh)
  // dashed center lines
  for (let i = -75; i <= 75; i += 8) {
    const dv = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 3), lineMat)
    dv.position.set(p, 0.03, i); scene.add(dv)
    const dh = new THREE.Mesh(new THREE.BoxGeometry(3, 0.06, 0.4), lineMat)
    dh.position.set(i, 0.03, p); scene.add(dh)
  }
}

// sidewalks along roads
const sideMat = new THREE.MeshLambertMaterial({color: 0xb8b8b0})
for (const p of [-25, 25]) {
  for (const off of [-(ROAD_W / 2 + 1.25), ROAD_W / 2 + 1.25]) {
    const sv = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.08, 160), sideMat)
    sv.position.set(p + off, 0.04, 0); sv.receiveShadow = true; scene.add(sv)
    const sh = new THREE.Mesh(new THREE.BoxGeometry(160, 0.08, 2.5), sideMat)
    sh.position.set(0, 0.04, p + off); sh.receiveShadow = true; scene.add(sh)
  }
}

// ---------- houses (walk right in through the open doorway!) ----------
const HOUSE_COLORS = [0xf7c6c7, 0xfbe8a6, 0xb3d9f7, 0xc8e6c9, 0xe1bee7, 0xffe0b2, 0xf0f4c3, 0xd7ccc8]
const BED_COLORS = [0xe53e3e, 0x3182ce, 0x38a169, 0x805ad5, 0xd53f8c, 0xdd6b20]
const CHAIR_COLORS = [0x8b5a2b, 0x6b4226, 0x9c6644, 0x7f5539]
const houseFootprints = []

// a little wooden chair: seat, back and four legs (seat top at y = 0.62)
function makeChair(color) {
  const c = new THREE.Group()
  c.add(box(0.9, 0.12, 0.9, color, 0, 0.56, 0))          // seat
  c.add(box(0.9, 0.95, 0.12, color, 0, 1.05, -0.39))     // backrest
  for (const [lx, lz] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
    c.add(box(0.12, 0.56, 0.12, color, lx, 0.28, lz))    // legs
  }
  return c
}
function makeHouse(x, z, facing) {
  const g = new THREE.Group()
  const c = pick(HOUSE_COLORS)
  const W = 10, H = 5, D = 8, T = 0.4, DOOR_W = 2.2
  const cosF = Math.round(Math.cos(facing))
  const sinF = Math.round(Math.sin(facing))
  // collider for a wall/furniture piece given LOCAL center + size (handles rotation)
  const addPart = (lx, lz, w, d) => {
    const wx = x + lx * cosF + lz * sinF
    const wz = z - lx * sinF + lz * cosF
    const rw = Math.abs(w * cosF) + Math.abs(d * sinF)
    const rd = Math.abs(w * sinF) + Math.abs(d * cosF)
    addCollider(wx, wz, rw, rd, 0.12)
  }
  // floor (top flush with the ground) + ceiling
  g.add(box(W - 0.1, 0.25, D - 0.1, 0x9b7653, 0, -0.12, 0))
  const ceiling = box(W, 0.2, D, c, 0, H + 0.1, 0)
  g.add(ceiling)
  // back + side walls
  g.add(box(W, H, T, c, 0, H / 2, -(D - T) / 2)); addPart(0, -(D - T) / 2, W, T)
  g.add(box(T, H, D, c, -(W - T) / 2, H / 2, 0)); addPart(-(W - T) / 2, 0, T, D)
  g.add(box(T, H, D, c, (W - T) / 2, H / 2, 0)); addPart((W - T) / 2, 0, T, D)
  // front wall with open doorway in the middle
  const segW = (W - DOOR_W) / 2
  for (const sx of [-(DOOR_W + segW) / 2, (DOOR_W + segW) / 2]) {
    g.add(box(segW, H, T, c, sx, H / 2, (D - T) / 2)); addPart(sx, (D - T) / 2, segW, T)
  }
  g.add(box(DOOR_W, H - 3.2, T, c, 0, 3.2 + (H - 3.2) / 2, (D - T) / 2)) // above the door
  g.add(box(DOOR_W + 0.5, 0.15, 0.5, 0x6b4226, 0, 3.28, (D - T) / 2 + 0.3)) // door trim
  // welcome mat
  g.add(box(1.8, 0.06, 1.1, 0xc05621, 0, 0.04, D / 2 + 0.8))
  // windows (visible from inside and outside)
  for (const wx of [-3, 3]) {
    g.add(box(1.8, 1.8, T + 0.15, 0xbde3ff, wx, 2.8, (D - T) / 2, {emissive: 0x224466}))
  }
  // roof (pyramid)
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.hypot(W, D) / 2 + 0.6, 3.2, 4),
    new THREE.MeshLambertMaterial({color: 0x9c4a3c})
  )
  roof.position.y = H + 1.8
  roof.rotation.y = Math.PI / 4
  roof.castShadow = true
  g.add(roof)
  // local (lx,lz) -> world, and local facing -> world yaw
  const toWorld = (lx, lz) => [x + lx * cosF + lz * sinF, z - lx * sinF + lz * cosF]

  // ----- furniture -----
  // bed in the back-right corner — press E at the foot of it to sleep
  const bedC = pick(BED_COLORS)
  g.add(box(2.2, 0.55, 3.4, bedC, 3.5, 0.28, -1.9))
  g.add(box(1.8, 0.22, 0.8, 0xffffff, 3.5, 0.66, -3.0))
  addPart(3.5, -1.9, 2.2, 3.4)
  {
    const [sx, sz] = toWorld(3.5, -0.5)
    spots.push({kind: 'sleep', label: 'sleep', x: sx, z: sz, yaw: facing, bodyY: 0.82, range: 2.6})
  }
  // table on the left
  g.add(box(2.4, 0.12, 1.4, 0x8b5a2b, -3.2, 0.95, -2.4))
  for (const [lx, lz] of [[-4.2, -2.9], [-2.2, -2.9], [-4.2, -1.9], [-2.2, -1.9]]) {
    g.add(box(0.15, 0.95, 0.15, 0x6b4226, lx, 0.48, lz))
  }
  addPart(-3.2, -2.4, 2.4, 1.4)
  // two chairs tucked up to the table, facing it
  for (const cxLocal of [-4.1, -2.3]) {
    const chair = makeChair(pick(CHAIR_COLORS))
    chair.position.set(cxLocal, 0, -0.8)
    chair.rotation.y = Math.PI          // seat faces the table (local -z)
    g.add(chair)
    addPart(cxLocal, -0.8, 0.95, 0.95)
    const [sx, sz] = toWorld(cxLocal, -0.68)
    spots.push({kind: 'sit', label: 'sit down', x: sx, z: sz, yaw: facing + Math.PI, bodyY: -0.28, range: 2.4})
  }
  // rug
  const rug = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 20),
    new THREE.MeshLambertMaterial({color: pick(BED_COLORS)})
  )
  rug.rotation.x = -Math.PI / 2
  rug.position.set(0, 0.02, 0.6)
  g.add(rug)

  g.position.set(x, 0, z)
  g.rotation.y = facing
  scene.add(g)
  houseFootprints.push({x, z, cosF, sinF, roof, ceiling})
}

// four residential blocks around the center park block
const blockCenters = [[-52, -52], [0, -52], [52, -52], [-52, 0], [52, 0], [-52, 52], [0, 52], [52, 52]]
for (const [bx, bz] of blockCenters) {
  for (const [hx, hz] of [[-12, -12], [12, -12], [-12, 12], [12, 12]]) {
    const x = bx + hx, z = bz + hz
    // face the nearest road
    let facing = 0
    if (Math.abs(x) > Math.abs(z)) facing = x > 0 ? -Math.PI / 2 : Math.PI / 2
    else facing = z > 0 ? Math.PI : 0
    // face toward road at ±25: flip so door looks at the road between blocks
    if (Math.abs(bx) === 52 && Math.abs(hx) === 12) facing = (bx + hx * 0.1) > 0 ? Math.PI / 2 : -Math.PI / 2
    makeHouse(x, z, facing)
  }
}

// ---------- central park ----------
const POND = {x: 0, z: 3, r: 8}
{
  // swimmable pond (see-through water)
  const pond = new THREE.Mesh(
    new THREE.CircleGeometry(POND.r, 36),
    new THREE.MeshLambertMaterial({color: 0x4aa3df, transparent: true, opacity: 0.75})
  )
  pond.rotation.x = -Math.PI / 2
  pond.position.set(POND.x, 0.06, POND.z)
  scene.add(pond)
  // pond bottom
  const bottom = new THREE.Mesh(
    new THREE.CircleGeometry(POND.r, 36),
    new THREE.MeshLambertMaterial({color: 0x8a9a5b})
  )
  bottom.rotation.x = -Math.PI / 2
  bottom.position.set(POND.x, -1.6, POND.z)
  scene.add(bottom)
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(POND.r, 0.35, 8, 36),
    new THREE.MeshLambertMaterial({color: 0x8d8d85})
  )
  rim.rotation.x = -Math.PI / 2
  rim.position.set(POND.x, 0.12, POND.z)
  scene.add(rim)
  // benches — sittable, seat top at 0.85
  for (const [bx, bz, ry] of [[-11, 3, Math.PI / 2], [11, 3, -Math.PI / 2], [0, -9, 0]]) {
    const bench = new THREE.Group()
    bench.add(box(3, 0.3, 1, 0x8b5a2b, 0, 0.7, 0))
    bench.add(box(3, 1, 0.25, 0x8b5a2b, 0, 1.4, -0.45))
    for (const lx of [-1.2, 1.2]) bench.add(box(0.25, 0.7, 0.9, 0x5a3a1a, lx, 0.35, 0))
    bench.position.set(bx, 0, bz)
    bench.rotation.y = ry
    scene.add(bench)
    const bw = Math.abs(Math.cos(ry)) * 3 + Math.abs(Math.sin(ry)) * 1.2
    const bd = Math.abs(Math.sin(ry)) * 3 + Math.abs(Math.cos(ry)) * 1.2
    addCollider(bx, bz, bw, bd)
    // two seats per bench, facing the way the bench faces (local +z)
    for (const off of [-0.7, 0.7]) {
      spots.push({
        kind: 'sit', label: 'sit down',
        x: bx + Math.cos(ry) * off - Math.sin(ry) * 0.2,
        z: bz - Math.sin(ry) * off - Math.cos(ry) * 0.2,
        yaw: ry, bodyY: -0.05, range: 3.2,
      })
    }
  }
}

// ---------- trees ----------
function makeTree(x, z, big) {
  const g = new THREE.Group()
  const th = big ? 3 : 2
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 0.5, th, 8),
    new THREE.MeshLambertMaterial({color: 0x7a5230})
  )
  trunk.position.y = th / 2
  trunk.castShadow = true
  g.add(trunk)
  const leaf = new THREE.Mesh(
    new THREE.SphereGeometry(big ? 2.4 : 1.7, 12, 10),
    new THREE.MeshLambertMaterial({color: pick([0x3e8948, 0x4caf50, 0x66a05b])})
  )
  leaf.position.y = th + (big ? 1.6 : 1.1)
  leaf.castShadow = true
  g.add(leaf)
  g.position.set(x, 0, z)
  scene.add(g)
  addCollider(x, z, 1, 1, 0.1)
}
// park trees
for (const [tx, tz] of [[-14, -6], [14, -6], [-8, 12], [8, 12], [-15, 14], [15, 14]]) makeTree(tx, tz, true)
// scattered neighborhood trees
for (let i = 0; i < 26; i++) {
  const x = (rand() - 0.5) * 190
  const z = (rand() - 0.5) * 190
  if (Math.abs(Math.abs(x) - 25) < 8 || Math.abs(Math.abs(z) - 25) < 8) continue // not on roads
  if (Math.abs(x) < 20 && Math.abs(z) < 20) continue // not in park middle
  let nearHouse = false
  for (const h of houseFootprints) {
    if (Math.abs(x - h.x) < 8.5 && Math.abs(z - h.z) < 7.5) { nearHouse = true; break }
  }
  if (!nearHouse) makeTree(x, z, rand() > 0.5)
}

// ---------- parked cars ----------
const CAR_COLORS = [0xe53e3e, 0x3182ce, 0xecc94b, 0xffffff, 0x2d3748, 0x38a169]
const cars = []
function makeCar(x, z, ry) {
  const g = new THREE.Group()
  const c = pick(CAR_COLORS)
  g.add(box(4.2, 1, 2, c, 0, 0.85, 0))
  g.add(box(2.2, 0.85, 1.8, 0xbde3ff, -0.2, 1.75, 0, {transparent: true, opacity: 0.75}))
  const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 12)
  const wheelMat = new THREE.MeshLambertMaterial({color: 0x1a202c})
  const wheels = []
  for (const [wx, wz] of [[-1.4, -1], [1.4, -1], [-1.4, 1], [1.4, 1]]) {
    const w = new THREE.Mesh(wheelGeo, wheelMat)
    w.rotation.x = Math.PI / 2
    w.position.set(wx, 0.45, wz)
    w.castShadow = true
    g.add(w)
    wheels.push(w)
  }
  g.position.set(x, 0, z)
  g.rotation.y = ry
  scene.add(g)
  const col = {minX: 0, maxX: 0, minZ: 0, maxZ: 0}
  colliders.push(col)
  const car = {group: g, wheels, col, x, z, yaw: ry, speed: 0, busyUntil: 0, idx: cars.length}
  cars.push(car)
  updateCarCollider(car)
  // stand-in spot: you press E next to the car to get in
  spots.push({kind: 'drive', label: 'drive', car, x, z, yaw: ry, bodyY: 0, range: 4.5})
  return car
}

// keep each car's box collider following it around (the car is long along its local x)
function updateCarCollider(car) {
  const hw = Math.abs(Math.cos(car.yaw)) * 2.3 + Math.abs(Math.sin(car.yaw)) * 1.2
  const hd = Math.abs(Math.sin(car.yaw)) * 2.3 + Math.abs(Math.cos(car.yaw)) * 1.2
  car.col.minX = car.x - hw; car.col.maxX = car.x + hw
  car.col.minZ = car.z - hd; car.col.maxZ = car.z + hd
}

// slide a car out of anything solid it drives into
function carHitsSomething(car) {
  const r = 2.0
  for (const c of colliders) {
    if (c === car.col) continue
    const nx = Math.max(c.minX, Math.min(car.x, c.maxX))
    const nz = Math.max(c.minZ, Math.min(car.z, c.maxZ))
    const dx = car.x - nx, dz = car.z - nz
    const d2 = dx * dx + dz * dz
    if (d2 < r * r) {
      const d = Math.sqrt(d2) || 0.001
      car.x = nx + (dx / d) * r
      car.z = nz + (dz / d) * r
      return true
    }
  }
  return false
}
for (const z of [-60, -40, 12, 40, 62]) makeCar(25 + ROAD_W / 2 + 2.8, z, Math.PI / 2)
for (const z of [-55, -10, 30, 55]) makeCar(-25 - ROAD_W / 2 - 2.8, z, Math.PI / 2)
for (const x of [-60, -12, 40, 60]) makeCar(x, -25 - ROAD_W / 2 - 2.8, 0)
for (const x of [-45, 8, 55]) makeCar(x, 25 + ROAD_W / 2 + 2.8, 0)

// ---------- clouds ----------
for (let i = 0; i < 10; i++) {
  const cloud = new THREE.Group()
  for (let j = 0; j < 3 + Math.floor(rand() * 3); j++) {
    const puff = new THREE.Mesh(
      new THREE.SphereGeometry(3 + rand() * 3, 8, 6),
      new THREE.MeshLambertMaterial({color: 0xffffff})
    )
    puff.position.set(j * 4 - 4, rand() * 1.5, rand() * 2)
    puff.scale.y = 0.55
    cloud.add(puff)
  }
  cloud.position.set((rand() - 0.5) * 260, 42 + rand() * 18, (rand() - 0.5) * 260)
  scene.add(cloud)
}

// world border fence (visual hint)
{
  const fenceMat = new THREE.MeshLambertMaterial({color: 0xffffff})
  for (const p of [-105, 105]) {
    const f1 = new THREE.Mesh(new THREE.BoxGeometry(212, 1.2, 0.3), fenceMat)
    f1.position.set(0, 0.6, p); scene.add(f1)
    const f2 = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 212), fenceMat)
    f2.position.set(p, 0.6, 0); scene.add(f2)
  }
}

// ============================================================
//  AVATARS
// ============================================================

function makeNameSprite(name) {
  const cv = document.createElement('canvas')
  cv.width = 512; cv.height = 128
  const ctx = cv.getContext('2d')
  ctx.font = 'bold 56px Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const w = Math.min(ctx.measureText(name).width + 50, 500)
  ctx.fillStyle = 'rgba(20,40,60,.55)'
  ctx.beginPath()
  ctx.roundRect(256 - w / 2, 24, w, 80, 20)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.fillText(name, 256, 66)
  const tex = new THREE.CanvasTexture(cv)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, depthTest: false}))
  sp.scale.set(4, 1, 1)
  return sp
}

function makeBubbleSprite() {
  const cv = document.createElement('canvas')
  cv.width = 512; cv.height = 128
  const tex = new THREE.CanvasTexture(cv)
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({map: tex, depthTest: false}))
  sp.scale.set(5, 1.25, 1)
  sp.visible = false
  sp.userData = {cv, tex, until: 0}
  return sp
}

function showBubble(sp, text) {
  const {cv, tex} = sp.userData
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, 512, 128)
  ctx.font = 'bold 44px Arial'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let t = text.length > 24 ? text.slice(0, 23) + '…' : text
  const w = Math.min(ctx.measureText(t).width + 56, 504)
  ctx.fillStyle = 'rgba(255,255,255,.95)'
  ctx.beginPath()
  ctx.roundRect(256 - w / 2, 16, w, 88, 24)
  ctx.fill()
  ctx.fillStyle = '#2d3748'
  ctx.fillText(t, 256, 62)
  tex.needsUpdate = true
  sp.visible = true
  sp.userData.until = performance.now() + 4500
}

// the classic smiley face, drawn onto a canvas and stuck on the front of the head
function makeFaceTexture(asleep) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const c = cv.getContext('2d')
  c.fillStyle = '#f5cd30'
  c.fillRect(0, 0, 128, 128)
  c.fillStyle = '#1a1a1a'
  if (asleep) {
    // two closed eyes: little downward arcs
    c.lineWidth = 6
    c.strokeStyle = '#1a1a1a'
    c.lineCap = 'round'
    for (const ex of [42, 86]) {
      c.beginPath()
      c.arc(ex, 52, 11, 0.15 * Math.PI, 0.85 * Math.PI)
      c.stroke()
    }
  } else {
    for (const ex of [42, 86]) {
      c.beginPath()
      c.ellipse(ex, 50, 8, 12, 0, 0, Math.PI * 2)
      c.fill()
    }
  }
  // wide friendly smile
  c.lineWidth = 7
  c.strokeStyle = '#1a1a1a'
  c.lineCap = 'round'
  c.beginPath()
  c.arc(64, 74, 22, 0.12 * Math.PI, 0.88 * Math.PI)
  c.stroke()
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
const FACE_AWAKE = makeFaceTexture(false)
const FACE_ASLEEP = makeFaceTexture(true)

function makeAvatar(shirtHex, name) {
  const g = new THREE.Group()          // outer: position + facing (name tag lives here)
  const body = new THREE.Group()       // inner: everything that tips/sinks when you sit or lie down
  g.add(body)

  const shirt = new THREE.MeshLambertMaterial({color: shirtHex})
  const skin = new THREE.MeshLambertMaterial({color: SKIN})
  const pants = new THREE.MeshLambertMaterial({color: PANTS})

  const mk = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat)
    m.castShadow = true
    return m
  }
  // Roblox R6-ish proportions: chunky torso, blocky limbs flush to the body
  // legs: hip joint + knee joint so they can fold into a sitting pose
  const makeLeg = side => {
    const hip = new THREE.Group()
    hip.position.set(side * 0.27, 0.9, 0)
    const thighGeo = new THREE.BoxGeometry(0.5, 0.46, 0.5)
    thighGeo.translate(0, -0.23, 0)
    hip.add(mk(thighGeo, pants))
    const knee = new THREE.Group()
    knee.position.y = -0.46
    const shinGeo = new THREE.BoxGeometry(0.5, 0.46, 0.5)
    shinGeo.translate(0, -0.23, 0)
    knee.add(mk(shinGeo, pants))
    hip.add(knee)
    body.add(hip)
    return {hip, knee}
  }
  const lLeg = makeLeg(-1)
  const rLeg = makeLeg(1)
  // torso
  const torso = mk(new THREE.BoxGeometry(1.05, 1.05, 0.55), shirt)
  torso.position.y = 1.42
  // arms (pivot at shoulder), flush against the torso like a Roblox character
  const armGeo = new THREE.BoxGeometry(0.5, 1.05, 0.5)
  armGeo.translate(0, -0.52, 0)
  const lArm = mk(armGeo, skin); lArm.position.set(-0.78, 1.94, 0)
  const rArm = mk(armGeo.clone(), skin); rArm.position.set(0.78, 1.94, 0)
  // head: yellow block with the smiley face on the front
  const faceMat = new THREE.MeshLambertMaterial({map: FACE_AWAKE})
  const headMats = [skin, skin, skin, skin, faceMat, skin]   // +x -x +y -y +z(front) -z
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.8, 0.8), headMats)
  head.castShadow = true
  head.position.y = 2.34

  body.add(torso, lArm, rArm, head)
  body.rotation.order = 'YXZ'

  const tag = makeNameSprite(name)
  tag.position.y = 3.25
  g.add(tag)
  const bubble = makeBubbleSprite()
  bubble.position.y = 4.1
  g.add(bubble)

  scene.add(g)
  return {group: g, body, lArm, rArm, lLeg, rLeg, faceMat, bubble, torso, head, tag, walkT: 0}
}

// what a character is currently doing
const POSE = {WALK: 0, SIT: 1, SLEEP: 2, DRIVE: 3}

function animateWalk(av, moving, dt, speedScale = 1, swimming = false, pose = POSE.WALK, bodyY = 0) {
  const k = Math.min(1, dt * 9)
  const ease = (obj, target) => { obj.rotation.x += (target - obj.rotation.x) * k }

  // hide the body while driving (you're inside the car — the name tag stays above it)
  const hidden = pose === POSE.DRIVE
  if (av.hidden !== hidden) { av.body.visible = !hidden; av.hidden = hidden }
  // eyes shut while asleep
  const sleepy = pose === POSE.SLEEP
  if (av.sleepy !== sleepy) {
    av.faceMat.map = sleepy ? FACE_ASLEEP : FACE_AWAKE
    av.faceMat.needsUpdate = true
    av.sleepy = sleepy
  }

  // sink/tip the body into the seat or bed
  av.body.position.y += (bodyY - av.body.position.y) * k
  const tilt = pose === POSE.SLEEP ? -Math.PI / 2 : (swimming && moving ? 1.15 : 0)
  av.body.rotation.x += (tilt - av.body.rotation.x) * k

  if (pose === POSE.SIT) {
    ease(av.lLeg.hip, -Math.PI / 2); ease(av.rLeg.hip, -Math.PI / 2)
    ease(av.lLeg.knee, Math.PI / 2); ease(av.rLeg.knee, Math.PI / 2)
    ease(av.lArm, -0.35); ease(av.rArm, -0.35)
    return
  }
  if (pose === POSE.SLEEP || pose === POSE.DRIVE) {
    for (const j of [av.lLeg.hip, av.rLeg.hip, av.lLeg.knee, av.rLeg.knee]) ease(j, 0)
    ease(av.lArm, 0); ease(av.rArm, 0)
    return
  }
  for (const j of [av.lLeg.knee, av.rLeg.knee]) ease(j, 0)

  if (swimming && moving) {
    // front-crawl arm strokes + leg flutter
    av.walkT += dt * 7
    av.lArm.rotation.x = Math.sin(av.walkT) * 1.7 - 0.8
    av.rArm.rotation.x = Math.sin(av.walkT + Math.PI) * 1.7 - 0.8
    av.lLeg.hip.rotation.x = Math.sin(av.walkT * 2.2) * 0.3
    av.rLeg.hip.rotation.x = -Math.sin(av.walkT * 2.2) * 0.3
  } else if (swimming) {
    // treading water
    av.walkT += dt * 4
    const s = Math.sin(av.walkT) * 0.3
    av.lArm.rotation.x = 0.5 + s
    av.rArm.rotation.x = 0.5 - s
    av.lLeg.hip.rotation.x = -s * 0.5
    av.rLeg.hip.rotation.x = s * 0.5
  } else if (moving) {
    av.walkT += dt * 9 * speedScale
    const s = Math.sin(av.walkT) * 0.65
    av.lArm.rotation.x = s
    av.rArm.rotation.x = -s
    av.lLeg.hip.rotation.x = -s
    av.rLeg.hip.rotation.x = s
  } else {
    for (const part of [av.lArm, av.rArm, av.lLeg.hip, av.rLeg.hip]) {
      part.rotation.x *= Math.max(0, 1 - dt * 10)
    }
  }
}

// ============================================================
//  PLAYER + CONTROLS
// ============================================================

let me = null           // my avatar
let myName = 'Player'
let myColorIdx = 1
const pos = new THREE.Vector3(0, 0, 16)
let yaw = 0             // avatar facing
let vy = 0
let grounded = true

let camYaw = 0, camPitch = 0.35, camDist = 9
let camPitchNow = 0.35, camDistNow = 9

let myPose = POSE.WALK
let myBodyY = 0
let myCar = null

const keys = {}
addEventListener('keydown', e => {
  if (chatOpen) return
  keys[e.code] = true
  if (e.code === 'Space') e.preventDefault()
  if (e.code === 'KeyE' && !e.repeat && me) interact()
})
addEventListener('keyup', e => { keys[e.code] = false })

// ---------- sit / sleep / drive ----------
const spotX = s => (s.car ? s.car.x : s.x)
const spotZ = s => (s.car ? s.car.z : s.z)

function nearestSpot() {
  let best = null, bestD = Infinity
  for (const s of spots) {
    if (s.car && s.car.busyUntil > performance.now()) continue
    const d = Math.hypot(pos.x - spotX(s), pos.z - spotZ(s))
    if (d < s.range && d < bestD) { bestD = d; best = s }
  }
  return best
}

function useSpot(s) {
  if (s.kind === 'drive') {
    myCar = s.car
    myCar.speed = 0
    myPose = POSE.DRIVE
    myBodyY = 0
    return
  }
  myPose = s.kind === 'sleep' ? POSE.SLEEP : POSE.SIT
  myBodyY = s.bodyY
  pos.set(s.x, 0, s.z)
  yaw = s.yaw
  vy = 0
  grounded = true
}

function getUp() {
  if (myPose === POSE.DRIVE && myCar) {
    // hop out beside the car
    const side = myCar.yaw
    pos.set(myCar.x + Math.sin(side) * 3.2, 0, myCar.z + Math.cos(side) * 3.2)
    myCar.speed = 0
    myCar = null
  } else {
    // step forward out of the seat
    pos.x += Math.sin(yaw) * 1.3
    pos.z += Math.cos(yaw) * 1.3
  }
  myPose = POSE.WALK
  myBodyY = 0
  collide()
}

function interact() {
  if (myPose !== POSE.WALK) { getUp(); return }
  if (isSwimming) return
  const s = nearestSpot()
  if (s) useSpot(s)
}

const promptEl = () => document.getElementById('prompt')
function updatePrompt() {
  const el = promptEl()
  const press = IS_TOUCH ? 'Tap' : 'Press'
  let text = ''
  if (myPose === POSE.DRIVE) {
    text = IS_TOUCH
      ? 'Tap <b>E</b> to get out &nbsp;·&nbsp; joystick to drive'
      : 'Press <b>E</b> to get out &nbsp;·&nbsp; <b>W/S</b> drive, <b>A/D</b> steer'
  } else if (myPose === POSE.SIT) text = press + ' <b>E</b> to stand up'
  else if (myPose === POSE.SLEEP) text = press + ' <b>E</b> to wake up'
  else {
    const s = nearestSpot()
    if (s) text = press + ' <b>E</b> to ' + s.label
  }
  el.style.display = text ? 'block' : 'none'
  if (text && el.innerHTML !== text) el.innerHTML = text
}

// car physics — the car body is long along its own x, so forward is (cos, -sin)
function driveCar(dt) {
  const car = myCar
  const throttle = -axisZ()   // push the stick / W forward to accelerate
  const steer = -axisX()      // left on the stick / A steers left

  const maxSpeed = wantsToRun() ? 24 : 15
  car.speed += throttle * 13 * dt
  car.speed *= 1 - dt * (Math.abs(throttle) < 0.05 ? 1.8 : 0.4)
  car.speed = Math.max(-8, Math.min(maxSpeed, car.speed))
  if (Math.abs(car.speed) > 0.2) {
    const grip = Math.min(1, Math.abs(car.speed) / 7)
    car.yaw += steer * 1.9 * grip * dt * Math.sign(car.speed)
  }
  car.x += Math.cos(car.yaw) * car.speed * dt
  car.z -= Math.sin(car.yaw) * car.speed * dt
  car.x = Math.max(-102, Math.min(102, car.x))
  car.z = Math.max(-102, Math.min(102, car.z))
  if (carHitsSomething(car)) car.speed *= -0.25
  updateCarCollider(car)
  car.group.position.set(car.x, 0, car.z)
  car.group.rotation.y = car.yaw

  pos.set(car.x, 0, car.z)
  yaw = car.yaw
  isMoving = Math.abs(car.speed) > 0.3
  // swing the camera round behind the car
  const want = Math.atan2(-Math.cos(car.yaw), Math.sin(car.yaw))
  let d = want - camYaw
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  camYaw += d * Math.min(1, dt * 2.5)
}

// drag to look around — tracks one pointer so a second finger can work the joystick
let dragId = null, lastX = 0, lastY = 0
canvas.addEventListener('pointerdown', e => {
  if (dragId !== null) return
  dragId = e.pointerId; lastX = e.clientX; lastY = e.clientY
})
addEventListener('pointerup', e => { if (e.pointerId === dragId) dragId = null })
addEventListener('pointercancel', e => { if (e.pointerId === dragId) dragId = null })
addEventListener('pointermove', e => {
  if (e.pointerId !== dragId) return
  camYaw -= (e.clientX - lastX) * 0.005
  camPitch = Math.min(1.2, Math.max(-0.1, camPitch + (e.clientY - lastY) * 0.004))
  lastX = e.clientX; lastY = e.clientY
})
addEventListener('wheel', e => {
  camDist = Math.min(16, Math.max(4, camDist + e.deltaY * 0.01))
})
// pinch to zoom
let pinchStart = null
canvas.addEventListener('touchmove', e => {
  if (e.touches.length !== 2) { pinchStart = null; return }
  const d = Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  )
  if (pinchStart === null) { pinchStart = {d, dist: camDist}; return }
  camDist = Math.min(16, Math.max(4, pinchStart.dist * (pinchStart.d / d)))
}, {passive: true})
canvas.addEventListener('touchend', () => { pinchStart = null })

// ---------- touch controls ----------
const IS_TOUCH = params.get('touch') === '1' ||
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
  'ontouchstart' in window
const stick = {x: 0, y: 0, run: false}
let jumpQueued = false
let resetStick = () => { stick.x = 0; stick.y = 0 }

// Never keep walking on your own: if the window loses focus, the tab is hidden,
// or a touch ends anywhere, drop every held key and re-centre the joystick.
function clearInput() {
  for (const k of Object.keys(keys)) keys[k] = false
  resetStick()
}
addEventListener('blur', clearInput)
addEventListener('contextmenu', clearInput)
document.addEventListener('visibilitychange', () => { if (document.hidden) clearInput() })
// safety net: if the joystick's own finger lifts anywhere on the page, re-centre it
// (but don't cancel it when a *second* finger — the camera drag — is released)
let stickPointerId = null
const releaseIfStick = e => { if (stickPointerId !== null && e.pointerId === stickPointerId) resetStick() }
addEventListener('pointerup', releaseIfStick)
addEventListener('pointercancel', releaseIfStick)

function setupTouchControls() {
  document.body.classList.add('touch')
  const pad = document.getElementById('stick')
  const nub = document.getElementById('stickNub')
  const R = 46 // how far the nub travels

  const moveNub = (dx, dy) => {
    const d = Math.hypot(dx, dy)
    const s = d > R ? R / d : 1
    nub.style.transform = `translate(${dx * s}px, ${dy * s}px)`
    stick.x = Math.max(-1, Math.min(1, dx / R))
    stick.y = Math.max(-1, Math.min(1, dy / R))
  }
  const resetNub = () => {
    nub.style.transform = ''
    stick.x = 0; stick.y = 0
    stickPointerId = null
  }
  resetStick = resetNub
  pad.addEventListener('pointerdown', e => {
    stickPointerId = e.pointerId
    try { pad.setPointerCapture(e.pointerId) } catch (_) {}
    const r = pad.getBoundingClientRect()
    moveNub(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
    e.preventDefault()
  })
  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== stickPointerId) return
    const r = pad.getBoundingClientRect()
    moveNub(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
  })
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) {
    pad.addEventListener(ev, e => { if (e.pointerId === stickPointerId) resetNub() })
  }

  const hold = (id, down, up) => {
    const el = document.getElementById(id)
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.classList.add('on'); down() })
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
      el.addEventListener(ev, () => { el.classList.remove('on'); if (up) up() })
    }
  }
  // latched so even a very quick tap always registers as one jump
  hold('btnJump', () => { keys.Space = true; jumpQueued = true }, () => { keys.Space = false })
  hold('btnE', () => { if (me) interact() })
  hold('btnChat', () => { toggleChat() })

  const runBtn = document.getElementById('btnRun')
  runBtn.addEventListener('pointerdown', e => {
    e.preventDefault()
    stick.run = !stick.run
    runBtn.classList.toggle('on', stick.run)
  })
}

// movement axes: keyboard and joystick added together
function axisX() {
  let v = 0
  if (keys.KeyA || keys.ArrowLeft) v -= 1
  if (keys.KeyD || keys.ArrowRight) v += 1
  return Math.max(-1, Math.min(1, v + stick.x))
}
function axisZ() {
  let v = 0
  if (keys.KeyW || keys.ArrowUp) v -= 1
  if (keys.KeyS || keys.ArrowDown) v += 1
  return Math.max(-1, Math.min(1, v + stick.y))
}
const wantsToRun = () => keys.ShiftLeft || keys.ShiftRight || stick.run

function collide() {
  const r = 0.75
  for (const c of colliders) {
    const nx = Math.max(c.minX, Math.min(pos.x, c.maxX))
    const nz = Math.max(c.minZ, Math.min(pos.z, c.maxZ))
    const dx = pos.x - nx, dz = pos.z - nz
    const d2 = dx * dx + dz * dz
    if (d2 < r * r) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2)
        pos.x = nx + (dx / d) * r
        pos.z = nz + (dz / d) * r
      } else {
        // inside the box: push out the shortest way
        const pushes = [
          [c.minX - r - pos.x, 0], [c.maxX + r - pos.x, 0],
          [0, c.minZ - r - pos.z], [0, c.maxZ + r - pos.z],
        ]
        pushes.sort((a, b) => (Math.abs(a[0] + a[1])) - (Math.abs(b[0] + b[1])))
        pos.x += pushes[0][0]; pos.z += pushes[0][1]
      }
    }
  }
  pos.x = Math.max(-104, Math.min(104, pos.x))
  pos.z = Math.max(-104, Math.min(104, pos.z))
}

// ============================================================
//  MULTIPLAYER
// ============================================================

let sendState = null
let sendChatMsg = null
let chatSeq = 0
let myRoom = ''
const peers = new Map() // peerId -> {av, target:{x,y,z,yaw}, moving, name, colorIdx, gotMeta}

const $ = id => document.getElementById(id)
const statusEl = $('status')

function setStatus(t, ok) {
  statusEl.textContent = t
  statusEl.style.background = ok ? 'rgba(56,161,105,.65)' : 'rgba(20,40,60,.55)'
}

function updateCount() {
  const n = peers.size + 1
  $('playerCount').textContent = n === 1
    ? (innerWidth < 820 ? '1 player' : '1 player (just you so far)')
    : n + ' players'
}

function addChatLine(html, sys) {
  const log = $('chatLog')
  const div = document.createElement('div')
  div.className = 'msg' + (sys ? ' sys' : '')
  div.innerHTML = html
  log.appendChild(div)
  while (log.children.length > 8) log.removeChild(log.firstChild)
  setTimeout(() => { div.style.transition = 'opacity 1s'; div.style.opacity = '0' }, 14000)
}
const esc = s => s.replace(/[<>&"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'}[c]))

// Join the same room on BOTH networks at once. Players are keyed by their own
// stable id (not the per-network peer id), so a friend reachable on both
// networks still shows up exactly once.
const rooms = []
let liveRelays = 0
const seenChat = new Set()

function broadcast(action, payload, toPeer) {
  for (const r of rooms) {
    // trystero actions are promise-based; a peer dropping mid-send must not throw
    try { r[action].send(payload, toPeer ? {target: toPeer} : {})?.catch?.(() => {}) } catch (_) {}
  }
}

function handleState(s) {
  if (!Array.isArray(s) || s.length < 12) return
  const [x, y, z, pyaw, moving, colorIdx, name, swim, pose, bodyY, carIdx, id] = s
  if (!id || id === MY_ID) return
  let p = peers.get(id)
  if (!p) {
    const safeName = String(name).slice(0, 16) || 'Friend'
    const av = makeAvatar(SHIRT_COLORS[colorIdx % SHIRT_COLORS.length], safeName)
    av.group.position.set(x, y, z)
    p = {av, target: {x, y, z, yaw: pyaw}, moving: false, name: safeName}
    peers.set(id, p)
    addChatLine('<b>' + esc(safeName) + '</b> joined the town! 👋', true)
    updateCount()
    setStatus('playing together ✓', true)
  }
  p.seen = performance.now()
  p.target = {x, y, z, yaw: pyaw}
  p.moving = !!moving
  p.swim = !!swim
  p.pose = pose || POSE.WALK
  p.bodyY = bodyY || 0
  // someone else is driving: move their car for everyone to see
  if (p.pose === POSE.DRIVE && carIdx >= 0 && cars[carIdx]) {
    const car = cars[carIdx]
    car.busyUntil = performance.now() + 2500
    car.x = x; car.z = z; car.yaw = pyaw
    car.group.position.set(x, 0, z)
    car.group.rotation.y = pyaw
    updateCarCollider(car)
  }
}

function handleChat(msg) {
  if (!msg || typeof msg !== 'object') return
  const {id, seq, text} = msg
  if (!id || id === MY_ID) return
  const key = id + ':' + seq
  if (seenChat.has(key)) return          // same message arriving via both networks
  seenChat.add(key)
  if (seenChat.size > 300) seenChat.clear()
  const p = peers.get(id)
  const name = p ? p.name : 'Friend'
  const clean = String(text).slice(0, 120)
  addChatLine('<b>' + esc(name) + ':</b> ' + esc(clean))
  if (p) showBubble(p.av.bubble, clean)
}

// drop players we stop hearing from (covers leaving, crashing, losing wifi)
function sweepPeers() {
  const now = performance.now()
  for (const [id, p] of peers) {
    if (now - (p.seen || 0) < 8000) continue
    addChatLine('<b>' + esc(p.name) + '</b> left the town', true)
    scene.remove(p.av.group)
    peers.delete(id)
    updateCount()
  }
}

function startMultiplayer(roomCode) {
  const networks = [
    {name: 'nostr', join: joinNostr, config: {appId: APP_ID, relayConfig: {urls: NOSTR_RELAYS}}},
    {name: 'mqtt', join: joinMqtt, config: {appId: APP_ID, relayConfig: {urls: MQTT_BROKERS}}},
  ]
  for (const net of networks) {
    try {
      const room = net.join(net.config, roomCode)
      const stateAction = room.makeAction('s')
      const chatAction = room.makeAction('c')
      stateAction.onMessage = payload => handleState(payload)
      chatAction.onMessage = payload => handleChat(payload)
      const entry = {room, s: stateAction, c: chatAction}
      // say hello straight away so the newcomer sees us without waiting a tick
      room.onPeerJoin = id => {
        try { stateAction.send(packState(), {target: id})?.catch?.(() => {}) } catch (_) {}
      }
      rooms.push(entry)
    } catch (err) {
      console.warn('could not join via ' + net.name + ':', err && err.message)
    }
  }

  if (!rooms.length) { setStatus('offline — solo mode', false); return }
  sendState = s => broadcast('s', s)
  sendChatMsg = text => broadcast('c', {id: MY_ID, seq: chatSeq++, text})

  checkRelays()
  setInterval(() => { if (me) sendState(packState()) }, 100)
  setInterval(sweepPeers, 2000)
}

// Honest status: actually try the matchmaking servers and say what happened,
// instead of claiming "online" the moment we start trying. (Only the nostr
// relays are probed — they're plain websockets; the MQTT brokers need a
// subprotocol handshake and would report false failures.)
function checkRelays() {
  const urls = NOSTR_RELAYS
  let settled = 0
  const done = () => {
    settled++
    if (peers.size) return
    if (liveRelays > 0) setStatus('online ✓ waiting for friends', true)
    else if (settled >= urls.length) {
      setStatus('⚠ trouble connecting', false)
      addChatLine('Having trouble reaching the matchmaking servers — still trying. ' +
        'If nobody shows up, try a different wifi or mobile data.', true)
    }
  }
  for (const url of urls) {
    let ws
    try { ws = new WebSocket(url) } catch (_) { done(); continue }
    const timer = setTimeout(() => { try { ws.close() } catch (_) {} ; done() }, 8000)
    ws.onopen = () => { liveRelays++; clearTimeout(timer); try { ws.close() } catch (_) {} ; done() }
    ws.onerror = () => { clearTimeout(timer); done() }
  }
  setTimeout(() => {
    if (!peers.size && liveRelays > 0) {
      addChatLine('Connected. Waiting for a friend to join room <b>' +
        esc(myRoom) + '</b> — they must type it exactly the same.', true)
    }
  }, 12000)
}

// tiny always-on hook so connection problems can be inspected from the console
window.__net = () => ({
  id: MY_ID,
  room: myRoom,
  networks: rooms.length,
  liveRelays,
  me: [+pos.x.toFixed(1), +pos.z.toFixed(1)],
  peers: [...peers.entries()].map(([id, p]) => ({
    id, name: p.name,
    x: +p.av.group.position.x.toFixed(1),
    z: +p.av.group.position.z.toFixed(1),
    pose: p.pose,
  })),
})

function packState() {
  return [
    +pos.x.toFixed(2), +pos.y.toFixed(2), +pos.z.toFixed(2),
    +yaw.toFixed(2), isMoving ? 1 : 0, myColorIdx, myName, isSwimming ? 1 : 0,
    myPose, +myBodyY.toFixed(2), myCar ? myCar.idx : -1, MY_ID,
  ]
}

// ============================================================
//  CHAT UI
// ============================================================

let chatOpen = false
const chatInput = $('chatInput')

function openChat() {
  chatOpen = true
  chatInput.style.display = 'block'
  chatInput.focus()
}
function closeChat() {
  chatInput.value = ''
  chatInput.blur()
  chatInput.style.display = 'none'
  chatOpen = false
}
function sendChat() {
  const text = chatInput.value.trim().slice(0, 120)
  if (text) {
    addChatLine('<b>' + esc(myName) + ':</b> ' + esc(text))
    if (me) showBubble(me.bubble, text)
    if (sendChatMsg) sendChatMsg(text)
  }
  closeChat()
}
function toggleChat() {
  if (!me) return
  if (chatOpen) sendChat(); else openChat()
}

addEventListener('keydown', e => {
  if (!me) return
  if (e.code === 'Enter') {
    if (!chatOpen) { openChat(); e.preventDefault() } else sendChat()
  } else if (e.code === 'Escape' && chatOpen) {
    closeChat()
  }
})

// ============================================================
//  START SCREEN
// ============================================================

const startEl = $('start')
const colorsEl = $('colors')
SHIRT_COLORS.forEach((c, i) => {
  const d = document.createElement('div')
  d.className = 'swatch' + (i === 1 ? ' sel' : '')
  d.style.background = '#' + c.toString(16).padStart(6, '0')
  d.onclick = () => {
    myColorIdx = i
    colorsEl.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'))
    d.classList.add('sel')
  }
  colorsEl.appendChild(d)
})

const FUN_ROOMS = ['cucumberlane', 'sunnystreet', 'picklepark', 'ourtown', 'pizzaparty', 'treehouse']
$('roomInput').value = params.get('room') || FUN_ROOMS[Math.floor(Math.random() * FUN_ROOMS.length)]
$('nameInput').value = params.get('name') || ''

function startGame() {
  myName = ($('nameInput').value.trim() || 'Player' + Math.floor(Math.random() * 99)).slice(0, 16)
  const roomCode = ($('roomInput').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'ourtown')
  myRoom = roomCode

  startEl.style.display = 'none'
  for (const id of ['roomInfo', 'help', 'chat', 'status']) $(id).style.display = 'block'
  addChatLine('Tip: go up to a <b>chair</b>, <b>bed</b> or <b>car</b> and ' +
    (IS_TOUCH ? 'tap' : 'press') + ' <b>E</b> 🚗', true)
  $('roomName').textContent = roomCode
  updateCount()

  if (IS_TOUCH) setupTouchControls()
  if (innerHeight > innerWidth) camDist = 12   // stand further back on a portrait screen
  fitCamera()

  me = makeAvatar(SHIRT_COLORS[myColorIdx], myName)
  me.group.position.copy(pos)
  addChatLine('Welcome to <b>Cucumber Town</b>! Explore the houses &amp; swim in the pond 🥒', true)

  if (DEV) {
    if (TEST_MODE) setStatus('test mode (solo)', false)
    window.__brooktownReady = true
    window.__tp = (x, z, cy, cdist) => {
      pos.x = x; pos.z = z
      if (cy !== undefined) camYaw = cy
      if (cdist !== undefined) camDist = cdist
    }
    window.__dbg = () => JSON.stringify({
      x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2),
      swim: isSwimming, moving: isMoving,
      indoors: !!insideHouse, roofHidden: insideHouse ? !insideHouse.roof.visible : null,
      pose: myPose, bodyY: +myBodyY.toFixed(2), touch: IS_TOUCH, stick: [stick.x, stick.y, stick.run],
      car: myCar ? {idx: myCar.idx, x: +myCar.x.toFixed(1), z: +myCar.z.toFixed(1), spd: +myCar.speed.toFixed(1)} : null,
      nearSpot: (() => { const s = nearestSpot(); return s ? s.label : null })(),
      cam: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)],
      camLocal: insideHouse ? (() => {
        const h = insideHouse
        const dx = camera.position.x - h.x, dz = camera.position.z - h.z
        return [+(dx * h.cosF - dz * h.sinF).toFixed(2), +(dx * h.sinF + dz * h.cosF).toFixed(2)]
      })() : null,
      playerLocal: insideHouse ? (() => {
        const h = insideHouse
        const dx = pos.x - h.x, dz = pos.z - h.z
        return [+(dx * h.cosF - dz * h.sinF).toFixed(2), +(dx * h.sinF + dz * h.cosF).toFixed(2)]
      })() : null,
      near: colliders.filter(c =>
        pos.x > c.minX - 1.5 && pos.x < c.maxX + 1.5 &&
        pos.z > c.minZ - 1.5 && pos.z < c.maxZ + 1.5
      ).map(c => [c.minX, c.maxX, c.minZ, c.maxZ].map(v => +v.toFixed(2))),
    })
  }
  if (!TEST_MODE) {
    setStatus('connecting…', false)
    startMultiplayer(roomCode)
  }
}
$('playBtn').onclick = startGame
$('nameInput').addEventListener('keydown', e => { if (e.code === 'Enter') startGame() })
$('roomInput').addEventListener('keydown', e => { if (e.code === 'Enter') startGame() })

if (TEST_MODE) {
  $('nameInput').value = 'Tester'
  startGame()
}

// ============================================================
//  GAME LOOP
// ============================================================

let isMoving = false
let isSwimming = false
let insideHouse = null
const clock = new THREE.Clock()

// Which house (if any) contains this spot?
function houseAt(x, z, mx = 4.7, mz = 3.9) {
  for (const h of houseFootprints) {
    const dx = x - h.x, dz = z - h.z
    const lx = dx * h.cosF - dz * h.sinF
    const lz = dx * h.sinF + dz * h.cosF
    if (Math.abs(lx) < mx && Math.abs(lz) < mz) return h
  }
  return null
}

// When you step into a house, lift its roof + ceiling off so you can see the
// whole room, and swing the camera up for a doll's-house view.
function updateInterior() {
  const found = houseAt(pos.x, pos.z)
  if (found === insideHouse) return
  if (insideHouse) { insideHouse.roof.visible = true; insideHouse.ceiling.visible = true }
  if (found) { found.roof.visible = false; found.ceiling.visible = false }
  insideHouse = found
}

function clampCamDist(desired) {
  const dx = Math.sin(camYaw) * Math.cos(camPitch)
  const dz = Math.cos(camYaw) * Math.cos(camPitch)
  for (let t = 1; t < desired; t += 0.4) {
    const cy = pos.y + 2 + Math.sin(camPitch) * t
    if (cy > 4.2) continue // above walls — nothing to clip
    const px = pos.x + dx * t
    const pz = pos.z + dz * t
    // don't let the camera sneak through an open doorway while you're outside
    if (cy < 5.2 && houseAt(px, pz, 4.7, 3.85)) return Math.max(2, t - 0.5)
    for (const c of colliders) {
      // ignore whatever you're standing/sitting in — it can't block its own occupant
      if (pos.x > c.minX && pos.x < c.maxX && pos.z > c.minZ && pos.z < c.maxZ) continue
      if (px > c.minX && px < c.maxX && pz > c.minZ && pz < c.maxZ) {
        return Math.max(2, t - 0.5)
      }
    }
  }
  return desired
}

function tick() {
  requestAnimationFrame(tick)
  const dt = Math.min(clock.getDelta(), 0.05)

  if (me) {
    const running = wantsToRun()
    if (myPose === POSE.DRIVE) {
      isSwimming = false
      driveCar(dt)
    } else if (myPose === POSE.SIT || myPose === POSE.SLEEP) {
      // seated: any movement input gets you back up
      isSwimming = false
      isMoving = false
      if (Math.abs(axisX()) > 0.3 || Math.abs(axisZ()) > 0.3 || keys.Space || jumpQueued) { jumpQueued = false; getUp() }
    } else {
      // input → movement relative to camera (keyboard and joystick both feed in here)
      const ix = axisX(), iz = axisZ()
      const mag = Math.min(1, Math.hypot(ix, iz))
      isSwimming = Math.hypot(pos.x - POND.x, pos.z - POND.z) < POND.r - 0.4
      const speed = (isSwimming ? 3.2 : (running ? 10 : 5.5)) * mag
      isMoving = mag > 0.08
      if (isMoving) {
        const ang = Math.atan2(ix, iz)
        const moveAng = camYaw + ang
        pos.x += Math.sin(moveAng) * speed * dt
        pos.z += Math.cos(moveAng) * speed * dt
        yaw = moveAng
      }
      // jump + gravity + swimming depth
      const floorY = isSwimming ? (isMoving ? -0.9 : -1.5) : 0
      if ((keys.Space || jumpQueued) && grounded) { vy = isSwimming ? 7 : 8.5; grounded = false }
      jumpQueued = false
      if (!grounded) {
        vy -= 22 * dt
        pos.y += vy * dt
        if (pos.y <= floorY) { pos.y = floorY; vy = 0; grounded = true }
      } else {
        // ease toward the floor (sink into water / climb back out)
        pos.y += (floorY - pos.y) * Math.min(1, dt * 6)
      }
      collide()
    }
    updatePrompt()

    me.group.position.copy(pos)
    if (isSwimming && grounded) me.group.position.y += Math.sin(performance.now() * 0.004) * 0.08
    // smooth turn
    let dy = yaw - me.group.rotation.y
    while (dy > Math.PI) dy -= Math.PI * 2
    while (dy < -Math.PI) dy += Math.PI * 2
    me.group.rotation.y += dy * Math.min(1, dt * 12)
    animateWalk(me, isMoving && (grounded || isSwimming), dt, running ? 1.5 : 1, isSwimming, myPose, myBodyY)
    if (me.bubble.visible && performance.now() > me.bubble.userData.until) me.bubble.visible = false

    // camera — indoors it lifts above the open walls for a doll's-house view,
    // outdoors it pulls in so it never clips through anything
    updateInterior()
    let wantPitch = camPitch, wantDist
    if (myPose === POSE.DRIVE) {
      wantPitch = Math.max(camPitch, 0.3)
      wantDist = Math.max(camDist, 13)
    } else if (insideHouse) {
      wantPitch = Math.max(camPitch, 1.1)
      wantDist = Math.max(camDist, 8)
    } else {
      wantDist = clampCamDist(camDist)
    }
    const smooth = Math.min(1, dt * 5)
    camPitchNow += (wantPitch - camPitchNow) * smooth
    camDistNow += (wantDist - camDistNow) * smooth
    let cx = pos.x + Math.sin(camYaw) * Math.cos(camPitchNow) * camDistNow
    let cz = pos.z + Math.cos(camYaw) * Math.cos(camPitchNow) * camDistNow
    const cy = pos.y + 2 + Math.sin(camPitchNow) * camDistNow
    if (insideHouse) {
      // keep the camera over the open room so no wall can hide you
      const h = insideHouse
      const dx = cx - h.x, dz = cz - h.z
      let lx = dx * h.cosF - dz * h.sinF
      let lz = dx * h.sinF + dz * h.cosF
      lx = Math.max(-4.2, Math.min(4.2, lx))
      lz = Math.max(-3.2, Math.min(3.2, lz))
      cx = h.x + lx * h.cosF + lz * h.sinF
      cz = h.z - lx * h.sinF + lz * h.cosF
    }
    camera.position.set(cx, Math.max(cy, 0.6), cz)
    camera.lookAt(pos.x, pos.y + 2, pos.z)
  }

  // remote players: interpolate toward their latest state
  for (const p of peers.values()) {
    const g = p.av.group
    const k = Math.min(1, dt * 10)
    g.position.x += (p.target.x - g.position.x) * k
    g.position.y += (p.target.y - g.position.y) * k
    g.position.z += (p.target.z - g.position.z) * k
    let dy = p.target.yaw - g.rotation.y
    while (dy > Math.PI) dy -= Math.PI * 2
    while (dy < -Math.PI) dy += Math.PI * 2
    g.rotation.y += dy * k
    animateWalk(p.av, p.moving, dt, 1, p.swim, p.pose || POSE.WALK, p.bodyY || 0)
    if (p.av.bubble.visible && performance.now() > p.av.bubble.userData.until) p.av.bubble.visible = false
  }

  renderer.render(scene, camera)
}
tick()
