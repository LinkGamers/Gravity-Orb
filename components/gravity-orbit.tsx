'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { gameAudio } from '@/lib/game-audio'
import { GameOverOverlay, StartOverlay } from './game-overlays'

// ---- Tunables ----------------------------------------------------------
const COLORS = {
  bg: '#0a0e1a',
  player: '#22f2e6',
  danger: '#ff2e6c',
  node: 'rgba(234, 246, 255, 0.22)',
  nodeCore: 'rgba(234, 246, 255, 0.5)',
  star: 'rgba(234, 246, 255, 0.35)',
}
const PLAYER_R = 7
const SPIKE_R = 9
const LAUNCH_SPEED = 640
const CAPTURE_PAD = 12
const GRACE_TIME = 0.34
const RECALL_WINDOW = 0.15 // seconds after launch a swipe can whip you back
const REVERSE_CD = 0.28
const SWIPE_DIST = 24 // px of pointer travel that counts as a swipe
const HS_KEY = 'gravity-orbit-highscore'

type Spike = { angle: number; speed: number }
type OrbitNode = {
  index: number
  x: number
  y: number
  r: number
  spin: number
  spikes: Spike[]
  pulse: number
}
type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  color: string
}

type Phase = 'ready' | 'playing' | 'over'

/**
 * The direction the player will fly if launched right now: the orbit tangent,
 * bent slightly toward a node that's roughly on target (aim assist).
 */
function computeLaunchDir(
  nodes: OrbitNode[],
  n: OrbitNode,
  px: number,
  py: number,
  angle: number,
): { tx: number; ty: number; target: OrbitNode | null } {
  const dir = Math.sign(n.spin) || 1
  let tx = -Math.sin(angle) * dir
  let ty = Math.cos(angle) * dir
  let bestDot = 0.62 // ~52 degree cone
  let ax = 0
  let ay = 0
  let target: OrbitNode | null = null
  for (const other of nodes) {
    if (other === n) continue
    const dx = other.x - px
    const dy = other.y - py
    const dist = Math.hypot(dx, dy)
    if (dist > 460) continue
    const d = (dx / dist) * tx + (dy / dist) * ty
    if (d > bestDot) {
      bestDot = d
      ax = dx / dist
      ay = dy / dist
      target = other
    }
  }
  if (target) {
    const k = 0.45
    const bx = tx * (1 - k) + ax * k
    const by = ty * (1 - k) + ay * k
    const bl = Math.hypot(bx, by) || 1
    tx = bx / bl
    ty = by / bl
  }
  return { tx, ty, target }
}

// Deterministic hash for the parallax star field
function hash2(ix: number, iy: number, seed: number) {
  let h = ix * 374761393 + iy * 668265263 + seed * 1274126177
  h = (h ^ (h >> 13)) * 1274126177
  h = h ^ (h >> 16)
  return (h >>> 0) / 4294967295
}

export default function GravityOrbit() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [phase, setPhase] = useState<Phase>('ready')
  const [score, setScore] = useState(0)
  const [highScore, setHighScore] = useState(0)
  const [finalScore, setFinalScore] = useState(0)
  const [isNewBest, setIsNewBest] = useState(false)
  const [muted, setMuted] = useState(false)
  const [showHint, setShowHint] = useState(true)

  // All mutable game state lives in a ref -> zero React overhead per frame
  const g = useRef({
    phase: 'ready' as Phase,
    w: 0,
    h: 0,
    dpr: 1,
    time: 0,
    nodes: [] as OrbitNode[],
    nextIndex: 0,
    lastGenY: 0,
    player: { x: 0, y: 0, angle: -Math.PI / 2, vx: 0, vy: 0 },
    mode: 'orbit' as 'orbit' | 'fly' | 'dead',
    current: null as OrbitNode | null,
    lastNode: null as OrbitNode | null,
    launched: false,
    grace: 0,
    flyTime: 0,
    recall: null as { node: OrbitNode; angle0: number } | null,
    reverseCd: 0,
    cameraTop: 0,
    score: 0,
    best: 0,
    particles: [] as Particle[],
    deathFlash: 0,
    shake: 0,
    overAt: 0,
    // smoothed aim vector so the indicator eases instead of snapping
    aimX: 0,
    aimY: -1,
    aimNode: null as OrbitNode | null,
    assistT: 0,
    // pointer gesture tracking
    ptr: { active: false, x0: 0, y0: 0, swiped: false },
  })

  const spawnNode = useCallback((y: number) => {
    const s = g.current
    const idx = s.nextIndex++
    const margin = 80
    const x =
      idx === 0
        ? s.w / 2
        : margin + Math.random() * Math.max(1, s.w - margin * 2)
    const r = 46 + Math.random() * 20
    const dir = Math.random() < 0.5 ? -1 : 1
    const spin =
      idx === 0
        ? 1.8
        : (2.1 + Math.random() * 0.9 + Math.min(idx * 0.05, 1.6)) * dir

    const spikes: Spike[] = []
    if (idx >= 4) {
      const count =
        idx >= 10 && Math.random() < 0.4 ? 2 : Math.random() < 0.45 ? 1 : 0
      for (let i = 0; i < count; i++) {
        spikes.push({
          angle: Math.random() * Math.PI * 2,
          speed: (0.8 + Math.random() * 1.1) * (Math.random() < 0.5 ? -1 : 1),
        })
      }
    }
    const node: OrbitNode = { index: idx, x, y, r, spin, spikes, pulse: 0 }
    s.nodes.push(node)
    s.lastGenY = y
    return node
  }, [])

  const resetWorld = useCallback(() => {
    const s = g.current
    s.nodes = []
    s.nextIndex = 0
    s.particles = []
    s.time = 0
    s.score = 0
    s.launched = false
    s.grace = 0
    s.flyTime = 0
    s.recall = null
    s.reverseCd = 0
    s.deathFlash = 0
    s.shake = 0
    s.assistT = 0
    s.aimNode = null
    const start = spawnNode(0)
    // pre-generate a screen and a half of nodes upward
    while (s.lastGenY > -(s.h * 1.6)) {
      spawnNode(s.lastGenY - (175 + Math.random() * 70))
    }
    s.current = start
    s.lastNode = null
    s.mode = 'orbit'
    s.player = {
      x: start.x + Math.cos(-Math.PI / 2) * start.r,
      y: start.y + Math.sin(-Math.PI / 2) * start.r,
      angle: -Math.PI / 2,
      vx: 0,
      vy: 0,
    }
    s.cameraTop = start.y - s.h * 0.62
    setScore(0)
  }, [spawnNode])

  const die = useCallback(() => {
    const s = g.current
    if (s.mode === 'dead') return
    s.mode = 'dead'
    s.phase = 'over'
    s.deathFlash = 1
    s.shake = 1
    s.overAt = performance.now()
    gameAudio.playDeath()
    // explosion burst
    for (let i = 0; i < 42; i++) {
      const a = Math.random() * Math.PI * 2
      const sp = 60 + Math.random() * 320
      s.particles.push({
        x: s.player.x,
        y: s.player.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.9,
        maxLife: 0.9,
        size: 2 + Math.random() * 3,
        color: Math.random() < 0.6 ? COLORS.player : COLORS.danger,
      })
    }
    const newBest = s.score > s.best
    if (newBest) {
      s.best = s.score
      try {
        localStorage.setItem(HS_KEY, String(s.best))
      } catch {}
    }
    setFinalScore(s.score)
    setHighScore(s.best)
    setIsNewBest(newBest && s.score > 0)
    setPhase('over')
  }, [])

  const launch = useCallback(() => {
    const s = g.current
    if (s.mode !== 'orbit' || !s.current) return
    const n = s.current
    // fire along the exact vector the indicator is showing
    let tx = s.aimX
    let ty = s.aimY
    if (!tx && !ty) {
      const d = computeLaunchDir(s.nodes, n, s.player.x, s.player.y, s.player.angle)
      tx = d.tx
      ty = d.ty
    }
    s.player.vx = tx * LAUNCH_SPEED
    s.player.vy = ty * LAUNCH_SPEED
    s.recall = { node: n, angle0: s.player.angle }
    s.flyTime = 0
    s.lastNode = n
    s.current = null
    s.mode = 'fly'
    s.launched = true
    gameAudio.playLaunch()
  }, [])

  /**
   * The escape move. Flips the spin of the ring you're on so you can swing
   * away from an oncoming spike. If you just launched, it whips you back onto
   * the ring first -- that's the "oh no, wrong moment" bail-out.
   */
  const reverse = useCallback(() => {
    const s = g.current
    if (s.phase !== 'playing' || s.mode === 'dead') return

    if (s.mode === 'fly' && s.recall && s.flyTime <= RECALL_WINDOW) {
      const n = s.recall.node
      // where the anchor point would be now, then flip
      s.player.angle = s.recall.angle0 + n.spin * s.flyTime
      n.spin *= -1
      s.current = n
      s.lastNode = null
      s.mode = 'orbit'
      s.player.vx = 0
      s.player.vy = 0
      // trail of the snap-back
      for (let i = 0; i < 14; i++) {
        const t = i / 14
        s.particles.push({
          x: s.player.x + (n.x + Math.cos(s.player.angle) * n.r - s.player.x) * t,
          y: s.player.y + (n.y + Math.sin(s.player.angle) * n.r - s.player.y) * t,
          vx: (Math.random() - 0.5) * 40,
          vy: (Math.random() - 0.5) * 40,
          life: 0.35,
          maxLife: 0.35,
          size: 2 + Math.random() * 2,
          color: COLORS.player,
        })
      }
      s.player.x = n.x + Math.cos(s.player.angle) * n.r
      s.player.y = n.y + Math.sin(s.player.angle) * n.r
      s.grace = 0.2
      s.recall = null
      s.reverseCd = REVERSE_CD
      n.pulse = 1
      gameAudio.playReverse()
      setShowHint(false)
      return
    }

    if (s.mode === 'orbit' && s.current && s.reverseCd <= 0) {
      s.current.spin *= -1
      s.current.pulse = 1
      s.reverseCd = REVERSE_CD
      gameAudio.playReverse()
      setShowHint(false)
    }
  }, [])

  const startGame = useCallback(() => {
    const s = g.current
    resetWorld()
    s.phase = 'playing'
    setPhase('playing')
    gameAudio.init()
    gameAudio.startMusic()
  }, [resetWorld])

  // Zero-lag input: the launch fires synchronously on pointerdown
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      gameAudio.init()
      const s = g.current
      s.ptr = { active: true, x0: e.clientX, y0: e.clientY, swiped: false }

      if (s.phase === 'ready') {
        startGame()
        return
      }
      if (s.phase === 'playing') {
        launch()
        return
      }
      // small delay guard so a frantic last tap doesn't skip the score screen
      if (s.phase === 'over' && performance.now() - s.overAt > 450) {
        startGame()
      }
    },
    [launch, startGame],
  )

  // A drag past the threshold in the same press = reverse gesture
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const s = g.current
      const p = s.ptr
      if (!p.active || p.swiped) return
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < SWIPE_DIST) return
      p.swiped = true
      reverse()
    },
    [reverse],
  )

  const onPointerUp = useCallback(() => {
    g.current.ptr.active = false
  }, [])

  // Keyboard for desktop: space launches, arrows / R reverse
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = g.current
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault()
        gameAudio.init()
        if (s.phase === 'ready') startGame()
        else if (s.phase === 'playing') launch()
        else if (performance.now() - s.overAt > 450) startGame()
      } else if (
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight' ||
        e.code === 'KeyR'
      ) {
        e.preventDefault()
        reverse()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [launch, reverse, startGame])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const s = g.current

    try {
      s.best = Number(localStorage.getItem(HS_KEY)) || 0
    } catch {}
    setHighScore(s.best)

    let vignette: CanvasGradient | null = null
    const resize = () => {
      const rect = container.getBoundingClientRect()
      s.w = rect.width
      s.h = rect.height
      s.dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(s.w * s.dpr)
      canvas.height = Math.round(s.h * s.dpr)
      const grd = ctx.createRadialGradient(
        s.w / 2,
        s.h / 2,
        Math.min(s.w, s.h) * 0.35,
        s.w / 2,
        s.h / 2,
        Math.max(s.w, s.h) * 0.78,
      )
      grd.addColorStop(0, 'rgba(0,0,0,0)')
      grd.addColorStop(1, 'rgba(0,0,0,0.55)')
      vignette = grd
    }
    resize()
    resetWorld()
    window.addEventListener('resize', resize)

    let raf = 0
    let last = performance.now()

    const step = (dt: number) => {
      const playing = s.phase === 'playing'
      s.time += dt
      if (s.reverseCd > 0) s.reverseCd -= dt
      // spikes rotate on every node
      for (const n of s.nodes) {
        for (const sp of n.spikes) sp.angle += sp.speed * dt
        if (n.pulse > 0) n.pulse -= dt * 2.2
      }

      if (s.mode === 'orbit' && s.current) {
        const n = s.current
        s.player.angle += n.spin * dt
        s.player.x = n.x + Math.cos(s.player.angle) * n.r
        s.player.y = n.y + Math.sin(s.player.angle) * n.r
      } else if (s.mode === 'fly') {
        s.flyTime += dt
        s.player.x += s.player.vx * dt
        s.player.y += s.player.vy * dt
        for (const n of s.nodes) {
          if (n === s.lastNode) continue
          const d = Math.hypot(s.player.x - n.x, s.player.y - n.y)
          if (d <= n.r + CAPTURE_PAD) {
            // snap onto the ring
            s.current = n
            s.mode = 'orbit'
            s.recall = null
            s.player.angle = Math.atan2(s.player.y - n.y, s.player.x - n.x)
            s.player.x = n.x + Math.cos(s.player.angle) * n.r
            s.player.y = n.y + Math.sin(s.player.angle) * n.r
            s.grace = GRACE_TIME
            n.pulse = 1
            gameAudio.playLand(n.index)
            if (n.index > s.score) {
              s.score = n.index
              setScore(n.index)
            }
            // landing pop
            for (let i = 0; i < 10; i++) {
              const a = Math.random() * Math.PI * 2
              const sp = 40 + Math.random() * 120
              s.particles.push({
                x: s.player.x,
                y: s.player.y,
                vx: Math.cos(a) * sp,
                vy: Math.sin(a) * sp,
                life: 0.4,
                maxLife: 0.4,
                size: 1.5 + Math.random() * 2,
                color: COLORS.player,
              })
            }
            break
          }
        }
      }

      if (s.grace > 0) s.grace -= dt

      // smooth the aim vector toward its target so the indicator eases
      if (s.mode === 'orbit' && s.current) {
        const d = computeLaunchDir(
          s.nodes,
          s.current,
          s.player.x,
          s.player.y,
          s.player.angle,
        )
        const snap = s.aimNode !== s.current
        s.aimNode = s.current
        const k = snap ? 1 : Math.min(1, dt * 14)
        s.aimX += (d.tx - s.aimX) * k
        s.aimY += (d.ty - s.aimY) * k
        const l = Math.hypot(s.aimX, s.aimY) || 1
        s.aimX /= l
        s.aimY /= l
        const want = d.target ? 1 : 0
        s.assistT += (want - s.assistT) * Math.min(1, dt * 9)
      }

      // spike collisions (only lethal in a real run)
      if (playing && s.mode !== 'dead' && s.grace <= 0) {
        for (const n of s.nodes) {
          if (Math.abs(n.y - s.player.y) > n.r + 60) continue
          for (const sp of n.spikes) {
            const sx = n.x + Math.cos(sp.angle) * n.r
            const sy = n.y + Math.sin(sp.angle) * n.r
            if (
              Math.hypot(s.player.x - sx, s.player.y - sy) <
              PLAYER_R + SPIKE_R
            ) {
              die()
              break
            }
          }
          if (s.mode === 'dead') break
        }
      }

      // trail particles
      if (s.mode !== 'dead') {
        const count = s.mode === 'fly' ? 3 : 1
        for (let i = 0; i < count; i++) {
          s.particles.push({
            x: s.player.x + (Math.random() - 0.5) * 4,
            y: s.player.y + (Math.random() - 0.5) * 4,
            vx: (Math.random() - 0.5) * 18,
            vy: (Math.random() - 0.5) * 18,
            life: 0.5 + Math.random() * 0.25,
            maxLife: 0.75,
            size: 2 + Math.random() * 2.5,
            color: COLORS.player,
          })
        }
      }
      for (let i = s.particles.length - 1; i >= 0; i--) {
        const p = s.particles[i]
        p.life -= dt
        if (p.life <= 0) {
          s.particles.splice(i, 1)
          continue
        }
        p.x += p.vx * dt
        p.y += p.vy * dt
      }

      // camera: auto-scroll up after first launch, always follow the player up
      if (playing) {
        if (s.launched) {
          const scroll = 16 + Math.min(s.score * 1.6, 70)
          s.cameraTop -= scroll * dt
        }
        const target = s.player.y - s.h * 0.45
        if (target < s.cameraTop) {
          s.cameraTop += (target - s.cameraTop) * Math.min(1, dt * 6)
        }

        // death: fell off the bottom or flew off the sides
        if (s.player.y - s.cameraTop > s.h + 40) die()
        if (s.mode === 'fly' && (s.player.x < -50 || s.player.x > s.w + 50)) die()
      }

      // generate ahead / prune behind
      while (s.lastGenY > s.cameraTop - 400) {
        spawnNode(s.lastGenY - (175 + Math.random() * 70))
      }
      s.nodes = s.nodes.filter((n) => n.y < s.cameraTop + s.h + 250)

      if (s.deathFlash > 0) s.deathFlash -= dt * 2.5
      if (s.shake > 0) s.shake -= dt * 3
    }

    const draw = () => {
      const { w, h, dpr, cameraTop } = s
      const sh = Math.max(0, s.shake)
      const ox = sh * (Math.random() - 0.5) * 16
      const oy = sh * (Math.random() - 0.5) * 16
      ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr)
      ctx.fillStyle = COLORS.bg
      ctx.fillRect(-20, -20, w + 40, h + 40)

      // parallax star field
      for (const layer of [0.35, 0.65]) {
        const cell = 130
        const top = cameraTop * layer
        const y0 = Math.floor(top / cell) - 1
        const y1 = Math.floor((top + h) / cell) + 1
        const x1 = Math.floor(w / cell) + 1
        for (let gy = y0; gy <= y1; gy++) {
          for (let gx = -1; gx <= x1; gx++) {
            const r1 = hash2(gx, gy, layer === 0.35 ? 7 : 13)
            if (r1 < 0.55) continue
            const r2 = hash2(gx, gy, 29)
            const sx = gx * cell + r1 * cell
            const sy = gy * cell + r2 * cell - top
            const tw = 0.7 + 0.3 * Math.sin(s.time * 1.6 + r1 * 12)
            ctx.globalAlpha = (0.15 + r2 * 0.3) * tw
            ctx.fillStyle = COLORS.star
            const size = layer === 0.35 ? 1.5 : 2
            ctx.fillRect(sx, sy, size, size)
          }
        }
      }
      ctx.globalAlpha = 1

      // nodes
      for (const n of s.nodes) {
        const sy = n.y - cameraTop
        if (sy < -120 || sy > h + 120) continue
        const active = n === s.current

        // ring: the active one is drawn as dashes flowing in the spin
        // direction, so which way you're going is always readable
        ctx.save()
        if (active) {
          ctx.setLineDash([11, 9])
          ctx.lineDashOffset = -s.time * n.spin * n.r * 0.85
          ctx.strokeStyle = 'rgba(34, 242, 230, 0.75)'
          ctx.lineWidth = 2.25
          ctx.shadowColor = COLORS.player
          ctx.shadowBlur = 10
        } else {
          ctx.strokeStyle = COLORS.node
          ctx.lineWidth = 1.25
        }
        ctx.beginPath()
        ctx.arc(n.x, sy, n.r, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()

        // landing / reverse pulse
        if (n.pulse > 0) {
          const p = n.pulse
          ctx.save()
          ctx.globalAlpha = p * 0.5
          ctx.strokeStyle = COLORS.player
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(n.x, sy, n.r + (1 - p) * 26, 0, Math.PI * 2)
          ctx.stroke()
          ctx.restore()
        }

        // core
        ctx.beginPath()
        ctx.arc(n.x, sy, active ? 4.5 : 3.5, 0, Math.PI * 2)
        ctx.fillStyle = active ? COLORS.player : COLORS.nodeCore
        if (active) {
          ctx.shadowColor = COLORS.player
          ctx.shadowBlur = 12
        }
        ctx.fill()
        ctx.shadowBlur = 0

        // spikes, with a faint sweep arc telegraphing where they're headed
        for (const sp of n.spikes) {
          const sweep = 0.55 * Math.sign(sp.speed)
          ctx.save()
          ctx.globalAlpha = 0.28
          ctx.strokeStyle = COLORS.danger
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(
            n.x,
            sy,
            n.r,
            sp.angle,
            sp.angle + sweep,
            sweep < 0,
          )
          ctx.stroke()
          ctx.restore()

          const sx = n.x + Math.cos(sp.angle) * n.r
          const spy = sy + Math.sin(sp.angle) * n.r
          ctx.save()
          ctx.translate(sx, spy)
          ctx.rotate(sp.angle)
          ctx.beginPath()
          ctx.moveTo(SPIKE_R + 3, 0)
          ctx.lineTo(-SPIKE_R * 0.7, -SPIKE_R * 0.8)
          ctx.lineTo(-SPIKE_R * 0.7, SPIKE_R * 0.8)
          ctx.closePath()
          ctx.fillStyle = COLORS.danger
          ctx.shadowColor = COLORS.danger
          ctx.shadowBlur = 14
          ctx.fill()
          ctx.restore()
          ctx.shadowBlur = 0
        }
      }

      // particles
      for (const p of s.particles) {
        const a = p.life / p.maxLife
        ctx.globalAlpha = a * 0.8
        ctx.beginPath()
        ctx.arc(p.x, p.y - cameraTop, p.size * a, 0, Math.PI * 2)
        ctx.fillStyle = p.color
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // aim indicator: a tapered tracer of dots along the real flight path,
      // plus a reticle on the node the assist has locked
      if (s.mode === 'orbit' && s.current && s.phase !== 'over') {
        const tx = s.aimX
        const ty = s.aimY
        const px = s.player.x
        const py = s.player.y - cameraTop
        const lock = s.assistT
        const d = computeLaunchDir(
          s.nodes,
          s.current,
          s.player.x,
          s.player.y,
          s.player.angle,
        )
        let len = 96 + lock * 40
        if (d.target) {
          const dist = Math.hypot(d.target.x - px, d.target.y - s.player.y)
          len = Math.min(len + 60, Math.max(60, dist - d.target.r - 6))
        }

        ctx.save()
        ctx.shadowColor = COLORS.player
        ctx.shadowBlur = 6 + lock * 8
        const dots = 9
        for (let i = 0; i < dots; i++) {
          const t = (i + 0.6) / dots
          // gentle travelling shimmer so it reads as "this way"
          const flow = 0.6 + 0.4 * Math.sin(s.time * 5 - i * 0.7)
          const dist = PLAYER_R + 6 + t * len
          const fade = (1 - t * 0.85) * (0.35 + lock * 0.5) * flow
          ctx.globalAlpha = Math.max(0, fade)
          ctx.beginPath()
          ctx.arc(px + tx * dist, py + ty * dist, (1 - t * 0.6) * 3.1, 0, Math.PI * 2)
          ctx.fillStyle = COLORS.player
          ctx.fill()
        }
        ctx.restore()

        if (d.target && lock > 0.05) {
          const ty2 = d.target.y - cameraTop
          ctx.save()
          ctx.globalAlpha = lock * 0.55
          ctx.strokeStyle = COLORS.player
          ctx.lineWidth = 2
          ctx.setLineDash([6, 10])
          ctx.lineDashOffset = -s.time * 30
          ctx.beginPath()
          ctx.arc(d.target.x, ty2, d.target.r + 9, 0, Math.PI * 2)
          ctx.stroke()
          ctx.restore()
        }
      }

      // player: soft halo + bright core
      if (s.mode !== 'dead') {
        const py = s.player.y - cameraTop
        ctx.save()
        ctx.globalAlpha = 0.18
        ctx.beginPath()
        ctx.arc(s.player.x, py, PLAYER_R + 7, 0, Math.PI * 2)
        ctx.fillStyle = COLORS.player
        ctx.fill()
        ctx.restore()
        ctx.beginPath()
        ctx.arc(s.player.x, py, PLAYER_R, 0, Math.PI * 2)
        ctx.fillStyle = COLORS.player
        ctx.shadowColor = COLORS.player
        ctx.shadowBlur = 20
        ctx.fill()
        ctx.shadowBlur = 0
      }

      // vignette keeps the neon off the edges of the screen
      if (vignette) {
        ctx.fillStyle = vignette
        ctx.fillRect(0, 0, w, h)
      }

      // death flash
      if (s.deathFlash > 0) {
        ctx.globalAlpha = Math.max(0, s.deathFlash) * 0.35
        ctx.fillStyle = COLORS.danger
        ctx.fillRect(0, 0, w, h)
        ctx.globalAlpha = 1
      }
    }

    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.033)
      last = now
      step(dt) // runs in every phase so the menu backdrop stays alive
      draw()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      gameAudio.stopMusic()
    }
  }, [die, resetWorld, spawnNode])

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative h-dvh w-full select-none overflow-hidden bg-game-bg"
      style={{ touchAction: 'none' }}
      role="application"
      aria-label="Gravity Orbit. Tap to launch between orbits, swipe to reverse your spin."
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* Mute toggle -- stops propagation so it never fires a launch */}
      <button
        type="button"
        onPointerDown={(e) => {
          e.stopPropagation()
          gameAudio.init()
          const next = !muted
          setMuted(next)
          gameAudio.setMuted(next)
        }}
        className="absolute bottom-5 right-5 z-20 flex h-11 w-11 items-center justify-center rounded-full border border-game-fg/10 bg-game-bg/50 text-game-fg/50 backdrop-blur-sm transition-colors hover:border-game-accent/40 hover:text-game-accent"
        aria-label={muted ? 'Unmute sound' : 'Mute sound'}
        aria-pressed={muted}
      >
        {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
      </button>

      {/* HUD */}
      {phase === 'playing' && (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-game-bg/80 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-5">
            <div
              key={score}
              className="animate-score-pop font-mono text-5xl font-bold tabular-nums text-game-fg drop-shadow-[0_0_12px_rgba(34,242,230,0.5)]"
            >
              {score}
            </div>
            <div className="text-right font-mono text-xs tracking-widest text-game-fg/45 tabular-nums">
              BEST {Math.max(highScore, score)}
            </div>
          </div>
          {showHint && (
            <p className="pointer-events-none absolute inset-x-0 bottom-8 text-center font-mono text-[11px] tracking-[0.2em] text-game-fg/40">
              SWIPE TO REVERSE SPIN
            </p>
          )}
        </>
      )}

      {phase === 'ready' && <StartOverlay highScore={highScore} />}
      {phase === 'over' && (
        <GameOverOverlay
          score={finalScore}
          highScore={highScore}
          isNewBest={isNewBest}
          onRestart={startGame}
        />
      )}
    </div>
  )
}
