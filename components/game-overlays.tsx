'use client'

import { MousePointerClick, RefreshCcw } from 'lucide-react'

function ControlRow({
  icon,
  label,
  detail,
}: {
  icon: React.ReactNode
  label: string
  detail: string
}) {
  return (
    <li className="flex items-center gap-3 text-left">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-game-fg/15 bg-game-fg/[0.04] text-game-accent">
        {icon}
      </span>
      <span className="flex flex-col">
        <span className="font-mono text-[11px] font-semibold tracking-[0.18em] text-game-fg/85">
          {label}
        </span>
        <span className="font-mono text-[11px] leading-snug text-game-fg/40">
          {detail}
        </span>
      </span>
    </li>
  )
}

export function StartOverlay({ highScore }: { highScore: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-game-bg/72 px-6 backdrop-blur-[2px]">
      <div className="animate-rise-in flex w-full max-w-[19rem] flex-col items-center gap-7">
        <div className="flex flex-col items-center gap-3">
          <span className="font-mono text-[10px] font-medium tracking-[0.42em] text-game-accent/70">
            NEON ARCADE
          </span>
          <h1 className="text-balance text-center font-mono text-[2.6rem] font-bold leading-[0.95] tracking-tight text-game-fg">
            GRAVITY
            <br />
            <span className="text-game-accent drop-shadow-[0_0_24px_rgba(34,242,230,0.45)]">
              ORBIT
            </span>
          </h1>
          <div
            className="h-px w-20 bg-gradient-to-r from-transparent via-game-accent/60 to-transparent"
            aria-hidden="true"
          />
        </div>

        <ul className="flex w-full flex-col gap-3 rounded-2xl border border-game-fg/10 bg-game-fg/[0.03] p-4">
          <ControlRow
            icon={<MousePointerClick className="h-4 w-4" aria-hidden="true" />}
            label="TAP"
            detail="Launch to the next orbit"
          />
          <ControlRow
            icon={<RefreshCcw className="h-4 w-4" aria-hidden="true" />}
            label="FLIP"
            detail="Reverse spin to dodge spikes"
          />
        </ul>

        <div className="flex flex-col items-center gap-2">
          <p className="animate-breathe font-mono text-base font-semibold tracking-[0.24em] text-game-accent">
            TAP TO START
          </p>
          {highScore > 0 && (
            <p className="font-mono text-[11px] tracking-[0.2em] text-game-fg/35 tabular-nums">
              BEST {highScore}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export function GameOverOverlay({
  score,
  highScore,
  isNewBest,
  onRestart,
}: {
  score: number
  highScore: number
  isNewBest: boolean
  onRestart: () => void
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-game-bg/80 px-6 backdrop-blur-[3px]">
      <div className="animate-rise-in flex w-full max-w-[17rem] flex-col items-center gap-6">
        <span className="font-mono text-[11px] font-semibold tracking-[0.34em] text-game-danger">
          RUN ENDED
        </span>

        <div className="flex w-full flex-col items-center gap-4 rounded-2xl border border-game-fg/10 bg-game-fg/[0.03] py-6">
          <span className="font-mono text-[10px] tracking-[0.3em] text-game-fg/40">
            ORBITS
          </span>
          <span className="font-mono text-6xl font-bold leading-none text-game-fg tabular-nums">
            {score}
          </span>
          {isNewBest ? (
            <span className="rounded-full border border-game-accent/40 bg-game-accent/10 px-3 py-1 font-mono text-[10px] font-semibold tracking-[0.22em] text-game-accent">
              NEW BEST
            </span>
          ) : (
            <span className="font-mono text-[11px] tracking-[0.2em] text-game-fg/40 tabular-nums">
              BEST {highScore}
            </span>
          )}
        </div>

        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation()
            onRestart()
          }}
          className="w-full rounded-full border border-game-accent/50 bg-game-accent/10 py-3.5 font-mono text-sm font-semibold tracking-[0.24em] text-game-accent transition-colors hover:bg-game-accent/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-game-accent active:bg-game-accent/25"
        >
          PLAY AGAIN
        </button>
        <p className="font-mono text-[10px] tracking-[0.2em] text-game-fg/25">
          OR TAP ANYWHERE
        </p>
      </div>
    </div>
  )
}
