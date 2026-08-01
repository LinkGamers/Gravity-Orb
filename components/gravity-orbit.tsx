'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCcw, RotateCcw, Volume2, VolumeX } from 'lucide-react'
import { gameAudio } from '@/lib/game-audio'
import { GameOverOverlay, StartOverlay } from './game-overlays'

// ---- Tunables ----------------------------------------------------------
const COLORS = {
  bg: '#0a0e1a',
  player: '#22f2e6',
  danger: '#ff2e6c',
  node: 'rgba(234, 246, 255, 0.2)',
  nodeCore: 'rgba(234, 246, 255, 0.45)',
  star: 'rgba(234, 246, 255, 0.4)',
  dim: 'rgba(234, 246, 255, 0.5)',
  }
const PLAYER_R = 7
const SPIKE_R = 8.5
const LAUNCH_SPEED = 620
const CAPTURE_PAD = 14
const GRACE_TIME = 0.45 // invulnerable window right after landing
const RECALL_WINDOW = 0.26 // seconds after launch a flip can whip you back
const REVERSE_CD = 0.2
const SWIPE_DIST = 20 // px of pointer travel that counts as a swipe
const MAX_FLY_TIME = 3 // safety net so a bad launch can't hang the run
const HS_KEY = 'gravity-orbit-highscore'

type Spike = { angle: number; speed: number; threat: number }
type OrbitNode = {
  index: number
  x: number
  y: number
  r: number
  spin: number
  spikes: Spike[]
  pulse: number
  born: number
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

const TAU = Math.PI * 2

/** Smooth 0..1 ramp between two edges -- kills the popping of hard cutoffs. */
function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Shortest signed angle from a to b, in -PI..PI. */
function angDelta(a: number, b: number) {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  if (d < -Math.PI) d += TAU
  return d
}

/** Frame-rate independent exponential smoothing factor. */
function ease(dt: number, rate: number) {
  return 1 - Math.exp(-dt * rate)
}

type Aim = {
  tx: number
  ty: number
  target: OrbitNode | null
  weight: number
}

/**
 * Direction the player flies if launched right now: the orbit tangent, bent
 * toward a node that's roughly on target. The bend is weighted by a smooth
 * falloff so the aim line eases in and out instead of snapping between nodes.
 */
function computeAim(
  nodes: OrbitNode[],
  n: OrbitNode,
  px: number,
  py: number,
  angle: number,
): Aim {
  const dir = Math.sign(n.spin) || 1
  const tx = -Math.sin(angle) * dir
  const ty = Math.cos(angle) * dir

  let target: OrbitNode | null = null
  let weight = 0
  let ax = 0
  let ay = 0

  for (const other of nodes) {
    if (other === n) continue
    const dx = other.x - px
    const dy = other.y - py
    const dist = Math.hypot(dx, dy) || 1
    if (dist > 540) continue
    const d = (dx / dist) * tx + (dy / dist) * ty
    // continuous confidence: how well aligned AND how close
    const w = smoothstep(0.5, 0.94, d) * smoothstep(540, 330, dist)
    if (w > weight) {
      weight = w
      ax = dx / dist
      ay = dy / dist
      target = other
    }
  }

  if (!target) return { tx, ty, target: null, weight: 0 }

  const k = 0.52 * weight
  const bx = tx * (1 - k) + ax * k
  const by = ty * (1 - k) + ay * k
  const bl = Math.hypot(bx, by) || 1
  return { tx: bx / bl, ty: by / bl, target, weight }
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
  // only flips on threshold crossings, so it costs ~nothing per frame
  const [threatened, setThreatened] = useState(false)

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
    // smoothed aim so the beam eases instead of snapping
    aimX: 0,
    aimY: -1,
    aimNode: null as OrbitNode | null,
    assist: 0,
    beamIn: 0,
    beamPhase: 0,
    // live lock read: is the beam actually pointing at a reachable ring?
    aimHasTarget: false,
    // brief flash when a tap is refused for having no lock
    denied: 0,
    // highest threat level on the ring we're riding (drives the warning UI)
    threat: 0,
    threatFlag: false,
    voidNear: 0,
    // pointer gesture tracking
    ptr: { active: false, x0: 0, y0: 0, swiped: false },
  })

  const spawnNode = useCallback((y: number) => {
    const s = g.current
    const idx = s.nextIndex++
    const margin = 66
    const prev = s.nodes[s.nodes.length - 1]

    // keep each node within a comfortable launch arc of the previous one so
    // every gap is actually reachable
    let x: number
    if (!prev) {
      x = s.w / 2
    } else {
      const spread = 95 + Math.random() * 105
      const side = Math.random() < 0.5 ? -1 : 1
      x = prev.x + side * spread
      if (x < margin || x > s.w - margin) x = prev.x - side * spread
      x = Math.min(s.w - margin, Math.max(margin, x))
    }

    const r = 44 + Math.random() * 20
    const dir = Math.random() < 0.5 ? -1 : 1
    const spin =
      idx === 0 ? 1.7 : (2 + Math.random() * 0.8 + Math.min(idx * 0.04, 1.4)) * dir

    const spikes: Spike[] = []
    if (idx >= 4) {
      const count =
        idx >= 12 && Math.random() < 0.35 ? 2 : Math.random() < 0.5 ? 1 : 0
      const base = Math.random() * TAU
      for (let i = 0; i < count; i++) {
        spikes.push({
          // two spikes always sit far apart so a safe pocket exists
          angle: base + i * (2.2 + Math.random() * 0.8),
          speed: (0.75 + Math.random()) * (i % 2 === 0 ? 1 : -1),
          threat: 0,
        })
      }
    }
    const node: OrbitNode = {
      index: idx,
      x,
      y,
      r,
      spin,
      spikes,
      pulse: 0,
      born: s.time,
    }
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
    s.assist = 0
    s.beamIn = 0
    s.beamPhase = 0
    s.threat = 0
    s.voidNear = 0
    s.aimNode = null
    const start = spawnNode(0)
    // pre-generate a couple of screens of nodes upward
    while (s.lastGenY > -(s.h * 1.6)) {
      spawnNode(s.lastGenY - (168 + Math.random() * 62))
    }
    s.current = start
    s.lastNode = null
    s.mode = 'orbit'
    s.player = {
      x: start.x,
      y: start.y - start.r,
      angle: -Math.PI / 2,
      vx: 0,
      vy: 0,
    }
    s.aimX = 1
    s.aimY = 0
    s.cameraTop = start.y - s.h * 0.6
    setScore(0)
    setThreatened(false)
    s.threatFlag = false
  }, [spawnNode])

  const die = useCallback(() => {
    const s = g.current
    if (s.mode === 'dead') return
    s.mode = 'dead'
    s.phase = 'over'
    s.deathFlash = 1
    s.shake = 1
    s.overAt = performance.now()
    s.threat = 0
    gameAudio.playDeath()
    gameAudio.setMusicVolume(0.05)
    // explosion burst
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * TAU
      const sp = 60 + Math.random() * 340
      s.particles.push({
        x: s.player.x,
        y: s.player.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 0.9,
        maxLife: 0.9,
        size: 2 + Math.random() * 3,
        color: Math.random() < 0.55 ? COLORS.player : COLORS.danger,
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
    setThreatened(false)
    setPhase('over')
  }, [])

  const launch = useCallback(() => {
    const s = g.current
    if (s.mode !== 'orbit' || !s.current) return
    const n = s.current

    // No ring in front of us: refuse the tap instead of flinging the player
    // into the void. A tap should never be an unavoidable death -- the beam
    // dims when there is nothing to catch, and this makes that promise real.
    if (!s.aimHasTarget) {
      s.denied = 1
      gameAudio.playDenied()
      return
    }

    // fire along the exact vector the beam is showing
    let tx = s.aimX
    let ty = s.aimY
    if (!tx && !ty) {
      const a = computeAim(s.nodes, n, s.player.x, s.player.y, s.player.angle)
      tx = a.tx
      ty = a.ty
    }
    s.player.vx = tx * LAUNCH_SPEED
    s.player.vy = ty * LAUNCH_SPEED
    s.recall = { node: n, angle0: s.player.angle }
    s.flyTime = 0
    s.lastNode = n
    s.current = null
    s.mode = 'fly'
    s.launched = true
    s.beamIn = 0
    s.threat = 0
    gameAudio.playLaunch()
  }, [])

  /**
   * The escape move. Flips the spin of the ring you're riding so you can swing
   * away from an oncoming spike. If you just launched, it whips you back onto
   * the ring first -- the "wrong moment" bail-out.
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
      const nx = n.x + Math.cos(s.player.angle) * n.r
      const ny = n.y + Math.sin(s.player.angle) * n.r
      // streak marking the snap-back
      for (let i = 0; i < 16; i++) {
        const t = i / 16
        s.particles.push({
          x: s.player.x + (nx - s.player.x) * t,
          y: s.player.y + (ny - s.player.y) * t,
          vx: (Math.random() - 0.5) * 40,
          vy: (Math.random() - 0.5) * 40,
          life: 0.35,
          maxLife: 0.35,
          size: 2 + Math.random() * 2,
          color: COLORS.player,
        })
      }
      s.player.x = nx
      s.player.y = ny
      s.grace = 0.25
      s.recall = null
      s.reverseCd = REVERSE_CD
      s.aimNode = null
      n.pulse = 1
      gameAudio.playReverse()
      setShowHint(false)
      return
    }

    if (s.mode === 'orbit' && s.current && s.reverseCd <= 0) {
      s.current.spin *= -1
      s.current.pulse = 1
      s.reverseCd = REVERSE_CD
      // the aim tangent mirrors instantly -- re-seed it so the beam sweeps
      // through the flip instead of teleporting
      s.assist = 0
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
    gameAudio.setMusicVolume(0.16)
    gameAudio.startMusic()
  }, [resetWorld])

  // Zero-lag input: the launch fires synchronously on pointerdown
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      e.preventDefault()
      gameAudio.init()
      const s = g.current
      s.ptr = { active: true, x0: e.clientX, y0: e.clientY, swiped: false }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}

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

  // The dedicated dodge control. Lives outside the launch surface so pressing
  // it can never fling you off the ring you're trying to survive on.
  const onReversePad = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      gameAudio.init()
      reverse()
    },
    [reverse],
  )

  const restart = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation()
      startGame()
    },
    [startGame],
  )

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
        e.code === 'ArrowDown' ||
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
    let started = false

    const resize = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const prevW = s.w
      s.w = rect.width
      s.h = rect.height
      s.dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(s.w * s.dpr)
      canvas.height = Math.round(s.h * s.dpr)

      const grd = ctx.createRadialGradient(
        s.w / 2,
        s.h / 2,
        Math.min(s.w, s.h) * 0.34,
        s.w / 2,
        s.h / 2,
        Math.max(s.w, s.h) * 0.8,
      )
      grd.addColorStop(0, 'rgba(0,0,0,0)')
      grd.addColorStop(1, 'rgba(0,0,0,0.6)')
      vignette = grd

      if (!started) {
        started = true
        resetWorld()
      } else if (prevW > 0 && Math.abs(prevW - s.w) > 1) {
        // keep the level playable when the viewport width changes mid-run
        const k = s.w / prevW
        for (const n of s.nodes) n.x *= k
        s.player.x *= k
      }
    }
    resize()

    const ro = new ResizeObserver(resize)
    ro.observe(container)

    let raf = 0
    let last = performance.now()
    // a hidden tab piles up elapsed time -- swallow it on return
    const onVisible = () => {
      last = performance.now()
    }
    document.addEventListener('visibilitychange', onVisible)

    const step = (dt: number) => {
      const playing = s.phase === 'playing'
      s.time += dt
      if (s.reverseCd > 0) s.reverseCd -= dt

      // spikes rotate on every node
      for (const n of s.nodes) {
        for (const sp of n.spikes) {
          sp.angle += sp.speed * dt
          if (sp.angle > TAU) sp.angle -= TAU
          if (sp.angle < 0) sp.angle += TAU
        }
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
            for (let i = 0; i < 12; i++) {
              const a = Math.random() * TAU
              const sp = 40 + Math.random() * 130
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
        if (playing && s.flyTime > MAX_FLY_TIME) die()
      }

      if (s.grace > 0) s.grace -= dt

      // ---- aim beam ------------------------------------------------------
      if (s.mode === 'orbit' && s.current) {
        const a = computeAim(
          s.nodes,
          s.current,
          s.player.x,
          s.player.y,
          s.player.angle,
        )
        if (s.aimNode !== s.current) {
          // new ring: seed straight onto the raw tangent, then let the assist
          // fade in. Avoids the beam sweeping across the screen on landing.
          s.aimNode = s.current
          s.aimX = a.tx
          s.aimY = a.ty
          s.assist = 0
          s.beamIn = 0
        } else {
          const k = ease(dt, 16)
          s.aimX += (a.tx - s.aimX) * k
          s.aimY += (a.ty - s.aimY) * k
          const l = Math.hypot(s.aimX, s.aimY) || 1
          s.aimX /= l
          s.aimY /= l
        }
        s.assist += (a.weight - s.assist) * ease(dt, 9)
        s.aimHasTarget = a.target !== null && a.weight > 0.12
        s.beamIn += (1 - s.beamIn) * ease(dt, 12)
        s.beamPhase = (s.beamPhase + dt * 0.85) % 1

        // ---- threat read: is a spike closing on us? ----------------------
        let threat = 0
        const n = s.current
        for (const sp of n.spikes) {
          const gap = angDelta(s.player.angle, sp.angle)
          const rel = sp.speed - n.spin
          // closing only if the gap is shrinking
          const closing = Math.sign(gap) !== Math.sign(rel) && rel !== 0
          const t = closing ? smoothstep(1.5, 0.25, Math.abs(gap)) : 0
          sp.threat += (t - sp.threat) * ease(dt, 10)
          if (sp.threat > threat) threat = sp.threat
        }
        s.threat += (threat - s.threat) * ease(dt, 10)
      } else {
        s.beamIn += (0 - s.beamIn) * ease(dt, 18)
        s.threat += (0 - s.threat) * ease(dt, 8)
        for (const n of s.nodes) {
          for (const sp of n.spikes) sp.threat += (0 - sp.threat) * ease(dt, 8)
        }
      }

      // surface the warning to the UI only when it crosses a threshold
      const flag = playing && s.threat > 0.55 && s.grace <= 0
      if (flag !== s.threatFlag) {
        s.threatFlag = flag
        setThreatened(flag)
      }

      // spike collisions (only lethal in a real run)
      if (playing && s.mode !== 'dead' && s.grace <= 0) {
        const hitR = PLAYER_R + SPIKE_R
        let hit = false
        for (const n of s.nodes) {
          if (Math.abs(n.y - s.player.y) > n.r + 60) continue
          for (const sp of n.spikes) {
            const sx = n.x + Math.cos(sp.angle) * n.r
            const sy = n.y + Math.sin(sp.angle) * n.r
            if (Math.hypot(s.player.x - sx, s.player.y - sy) < hitR) {
              hit = true
              break
            }
          }
          if (hit) break
        }
        if (hit) die()
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
          const scroll = 16 + Math.min(s.score * 1.5, 66)
          s.cameraTop -= scroll * dt
        }
        const target = s.player.y - s.h * 0.45
        if (target < s.cameraTop) {
          s.cameraTop += (target - s.cameraTop) * ease(dt, 6)
        }

        // how close the void at the bottom is, for the warning gradient
        const depth = s.player.y - s.cameraTop
        s.voidNear = smoothstep(s.h * 0.7, s.h * 0.98, depth)

        // death: fell off the bottom or flew off the sides
        if (depth > s.h + 40) die()
        if (s.mode === 'fly' && (s.player.x < -60 || s.player.x > s.w + 60)) die()
      } else {
        s.voidNear += (0 - s.voidNear) * ease(dt, 6)
      }

      // generate ahead / prune behind
      while (s.lastGenY > s.cameraTop - 420) {
        spawnNode(s.lastGenY - (168 + Math.random() * 62))
      }
      s.nodes = s.nodes.filter(
        (n) => n.y < s.cameraTop + s.h + 260 || n === s.current,
      )

      if (s.deathFlash > 0) s.deathFlash -= dt * 2.5
      if (s.shake > 0) s.shake -= dt * 3
      if (s.denied > 0) s.denied = Math.max(0, s.denied - dt * 3.2)
    }

    /** The launch beam: a soft neon streak with a pulse travelling outward. */
    const drawBeam = (px: number, py: number, aim: Aim) => {
      const alpha = s.beamIn
      if (alpha < 0.02) return
      const tx = s.aimX
      const ty = s.aimY
      const lock = s.assist

      let len = 104 + lock * 34
      if (aim.target) {
        const dist = Math.hypot(aim.target.x - px, aim.target.y - s.player.y)
        len = Math.min(len + 70, Math.max(66, dist - aim.target.r - 8))
      }

      const x0 = px + tx * (PLAYER_R + 5)
      const y0 = py + ty * (PLAYER_R + 5)
      const x1 = px + tx * (PLAYER_R + 5 + len)
      const y1 = py + ty * (PLAYER_R + 5 + len)

      const grd = ctx.createLinearGradient(x0, y0, x1, y1)
      grd.addColorStop(0, `rgba(34, 242, 230, ${0.85 * alpha})`)
      grd.addColorStop(0.55, `rgba(34, 242, 230, ${0.4 * alpha})`)
      grd.addColorStop(1, 'rgba(34, 242, 230, 0)')

      ctx.save()
      ctx.lineCap = 'round'

      // wide glow, then a tight core -- reads as light, not as a UI arrow
      ctx.globalAlpha = 0.16 * alpha * (0.6 + lock * 0.4)
      ctx.strokeStyle = COLORS.player
      ctx.lineWidth = 10
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()

      ctx.globalAlpha = 1
      ctx.strokeStyle = grd
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()

      // single pulse riding the beam -- continuous, so no strobing
      const t = s.beamPhase
      const fade = Math.sin(t * Math.PI)
      const cx = x0 + (x1 - x0) * t
      const cy = y0 + (y1 - y0) * t
      ctx.globalAlpha = fade * 0.8 * alpha
      ctx.fillStyle = COLORS.player
      ctx.shadowColor = COLORS.player
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.arc(cx, cy, 2.6, 0, TAU)
      ctx.fill()
      ctx.shadowBlur = 0

      // soft tip cap that grows as the aim assist locks on
      ctx.globalAlpha = (0.25 + lock * 0.55) * alpha
      ctx.beginPath()
      ctx.arc(x1, y1, 2 + lock * 2.4, 0, TAU)
      ctx.fill()

      // lock brackets: two short ticks that close in on the tip once a ring is
      // actually catchable. This is the "safe to tap" tell.
      if (s.aimHasTarget) {
        const gap = 9 - lock * 4
        const nx = -ty
        const ny = tx
        ctx.globalAlpha = lock * 0.9 * alpha
        ctx.strokeStyle = COLORS.player
        ctx.lineWidth = 1.6
        for (const sgn of [-1, 1]) {
          ctx.beginPath()
          ctx.moveTo(x1 + nx * gap * sgn - tx * 4, y1 + ny * gap * sgn - ty * 4)
          ctx.lineTo(x1 + nx * gap * sgn + tx * 4, y1 + ny * gap * sgn + ty * 4)
          ctx.stroke()
        }
      } else {
        // no ring ahead -- mark the beam as cold so the player waits
        ctx.globalAlpha = 0.5 * alpha
        ctx.strokeStyle = COLORS.dim
        ctx.lineWidth = 1.4
        ctx.setLineDash([3, 6])
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()

      // refusal ripple: feedback that the tap registered but was held back
      if (s.denied > 0) {
        const d = s.denied
        ctx.save()
        ctx.globalAlpha = d * 0.7
        ctx.strokeStyle = COLORS.dim
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(px, py, PLAYER_R + 6 + (1 - d) * 18, 0, TAU)
        ctx.stroke()
        ctx.restore()
      }
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
            ctx.globalAlpha = (0.14 + r2 * 0.28) * tw
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
        if (sy < -140 || sy > h + 140) continue
        const active = n === s.current
        // fade a node in as it is generated so nothing ever pops into frame
        const fade = Math.min(1, (s.time - n.born) * 3.2)

        ctx.save()
        ctx.globalAlpha = fade
        if (active) {
          // dashes flow in the spin direction, so which way you're going is
          // always readable at a glance
          const heat = s.threat
          ctx.setLineDash([11, 9])
          ctx.lineDashOffset = -s.time * n.spin * n.r * 0.85
          ctx.strokeStyle = heat > 0.05 ? COLORS.danger : 'rgba(34, 242, 230, 0.78)'
          ctx.globalAlpha = fade * (heat > 0.05 ? 0.45 + heat * 0.5 : 0.85)
          ctx.lineWidth = 2.25
          ctx.shadowColor = heat > 0.05 ? COLORS.danger : COLORS.player
          ctx.shadowBlur = 10 + heat * 8
        } else {
          ctx.strokeStyle = COLORS.node
          ctx.lineWidth = 1.25
        }
        ctx.beginPath()
        ctx.arc(n.x, sy, n.r, 0, TAU)
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
          ctx.arc(n.x, sy, n.r + (1 - p) * 26, 0, TAU)
          ctx.stroke()
          ctx.restore()
        }

        // core
        ctx.save()
        ctx.globalAlpha = fade
        ctx.beginPath()
        ctx.arc(n.x, sy, active ? 4.5 : 3.5, 0, TAU)
        ctx.fillStyle = active ? COLORS.player : COLORS.nodeCore
        if (active) {
          ctx.shadowColor = COLORS.player
          ctx.shadowBlur = 12
        }
        ctx.fill()
        ctx.restore()

        // spikes, with a sweep arc telegraphing where they're headed
        for (const sp of n.spikes) {
          const sweep = 0.6 * Math.sign(sp.speed)
          const heat = sp.threat
          ctx.save()
          ctx.globalAlpha = (0.24 + heat * 0.5) * fade
          ctx.strokeStyle = COLORS.danger
          ctx.lineWidth = 3 + heat * 2
          ctx.beginPath()
          ctx.arc(n.x, sy, n.r, sp.angle, sp.angle + sweep, sweep < 0)
          ctx.stroke()
          ctx.restore()

          const sx = n.x + Math.cos(sp.angle) * n.r
          const spy = sy + Math.sin(sp.angle) * n.r
          ctx.save()
          ctx.globalAlpha = fade
          ctx.translate(sx, spy)
          ctx.rotate(sp.angle)
          const grow = 1 + heat * 0.18
          ctx.beginPath()
          ctx.moveTo((SPIKE_R + 3) * grow, 0)
          ctx.lineTo(-SPIKE_R * 0.7 * grow, -SPIKE_R * 0.8 * grow)
          ctx.lineTo(-SPIKE_R * 0.7 * grow, SPIKE_R * 0.8 * grow)
          ctx.closePath()
          ctx.fillStyle = COLORS.danger
          ctx.shadowColor = COLORS.danger
          ctx.shadowBlur = 14 + heat * 14
          ctx.fill()
          ctx.restore()
        }
      }

      // particles
      for (const p of s.particles) {
        const a = p.life / p.maxLife
        ctx.globalAlpha = a * 0.8
        ctx.beginPath()
        ctx.arc(p.x, p.y - cameraTop, p.size * a, 0, TAU)
        ctx.fillStyle = p.color
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // aim beam + lock-on reticle
      if (s.mode === 'orbit' && s.current && s.phase !== 'over') {
        const aim = computeAim(
          s.nodes,
          s.current,
          s.player.x,
          s.player.y,
          s.player.angle,
        )
        drawBeam(s.player.x, s.player.y - cameraTop, aim)

        if (aim.target && s.assist > 0.06) {
          const lock = s.assist
          const ty2 = aim.target.y - cameraTop
          ctx.save()
          ctx.globalAlpha = lock * 0.5 * s.beamIn
          ctx.strokeStyle = COLORS.player
          ctx.lineWidth = 1.75
          ctx.setLineDash([5, 11])
          ctx.lineDashOffset = -s.time * 28
          ctx.beginPath()
          ctx.arc(aim.target.x, ty2, aim.target.r + 8 + (1 - lock) * 12, 0, TAU)
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
        ctx.arc(s.player.x, py, PLAYER_R + 7, 0, TAU)
        ctx.fillStyle = COLORS.player
        ctx.fill()
        ctx.restore()
        ctx.save()
        ctx.beginPath()
        ctx.arc(s.player.x, py, PLAYER_R, 0, TAU)
        ctx.fillStyle = COLORS.player
        ctx.shadowColor = COLORS.player
        ctx.shadowBlur = 20
        ctx.fill()
        ctx.restore()
      }

      // vignette keeps the neon off the edges of the screen
      if (vignette) {
        ctx.fillStyle = vignette
        ctx.fillRect(0, 0, w, h)
      }

      // the void closing in from below
      if (s.voidNear > 0.01) {
        const vg = ctx.createLinearGradient(0, h, 0, h - 190)
        vg.addColorStop(0, `rgba(255, 46, 108, ${0.4 * s.voidNear})`)
        vg.addColorStop(1, 'rgba(255, 46, 108, 0)')
        ctx.fillStyle = vg
        ctx.fillRect(0, h - 190, w, 190)
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
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisible)
      gameAudio.stopMusic()
    }
  }, [die, resetWorld, spawnNode])

  const iconBtn =
    'flex h-9 w-9 items-center justify-center rounded-full border border-game-fg/10 bg-game-fg/[0.04] text-game-fg/45 backdrop-blur-sm transition-colors hover:border-game-accent/40 hover:text-game-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-game-accent'

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="relative h-dvh w-full select-none overflow-hidden bg-game-bg"
      style={{ touchAction: 'none', WebkitTapHighlightColor: 'transparent' }}
      role="application"
      aria-label="Gravity Orbit. Tap to launch between orbits, use the flip pad or swipe to reverse your spin."
    >
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* Top HUD -- always mounted so the layout never jumps between phases */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-4 p-4">
        <div
          key={score}
          className={`animate-score-pop origin-top-left font-mono text-5xl font-bold leading-none tabular-nums text-game-fg drop-shadow-[0_0_14px_rgba(34,242,230,0.45)] transition-opacity duration-300 ${
            phase === 'playing' ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {score}
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          <span
            className={`font-mono text-[10px] tracking-[0.2em] text-game-fg/40 tabular-nums transition-opacity duration-300 ${
              phase === 'playing' ? 'opacity-100' : 'opacity-0'
            }`}
          >
            BEST {Math.max(highScore, score)}
          </span>
          {phase === 'playing' && (
            <button
              type="button"
              onPointerDown={restart}
              className={iconBtn}
              aria-label="Restart run"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation()
              gameAudio.init()
              const next = !muted
              setMuted(next)
              gameAudio.setMuted(next)
            }}
            className={iconBtn}
            aria-label={muted ? 'Unmute sound' : 'Mute sound'}
            aria-pressed={muted}
          >
            {muted ? (
              <VolumeX className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {phase === 'playing' && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-gradient-to-b from-game-bg/85 to-transparent" />
      )}

      {/* The dodge control. Its own hit area, so it never triggers a launch. */}
      {phase === 'playing' && (
        <div className="absolute inset-x-0 bottom-0 z-20 flex flex-col items-center gap-3 pb-7">
          {showHint && (
            <p className="pointer-events-none font-mono text-[10px] tracking-[0.22em] text-game-fg/35">
              FLIP TO DODGE THE SPIKES
            </p>
          )}
          <button
            type="button"
            onPointerDown={onReversePad}
            className={`flex h-[68px] w-[68px] items-center justify-center rounded-full border-2 backdrop-blur-sm transition-all duration-200 active:scale-90 ${
              threatened
                ? 'border-game-danger/70 bg-game-danger/15 text-game-danger shadow-[0_0_28px_rgba(255,46,108,0.45)]'
                : 'border-game-accent/40 bg-game-accent/10 text-game-accent shadow-[0_0_18px_rgba(34,242,230,0.2)]'
            }`}
            aria-label="Reverse orbit direction"
          >
            <RefreshCcw className="h-7 w-7" aria-hidden="true" />
          </button>
        </div>
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
