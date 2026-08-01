'use client'

export function StartOverlay({ highScore }: { highScore: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-balance font-mono text-4xl font-bold tracking-widest text-game-fg drop-shadow-[0_0_20px_rgba(34,242,230,0.6)] sm:text-5xl">
        GRAVITY
        <span className="text-game-accent"> ORBIT</span>
      </h1>
      <p className="max-w-xs text-pretty font-mono text-sm leading-relaxed text-game-fg/60">
        Tap to launch between spinning orbits. Dodge the spikes. Outrun the
        void below.
      </p>
      {highScore > 0 && (
        <p className="font-mono text-xs text-game-fg/40 tabular-nums">
          BEST {highScore}
        </p>
      )}
      <p className="animate-pulse font-mono text-lg font-semibold tracking-widest text-game-accent">
        TAP TO START
      </p>
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
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-game-bg/70 p-6 text-center backdrop-blur-sm">
      <h2 className="font-mono text-2xl font-bold tracking-widest text-game-danger drop-shadow-[0_0_16px_rgba(255,46,108,0.6)]">
        GAME OVER
      </h2>
      <div className="flex flex-col items-center gap-1">
        <span className="font-mono text-7xl font-bold text-game-fg tabular-nums">
          {score}
        </span>
        {isNewBest ? (
          <span className="font-mono text-sm font-semibold tracking-widest text-game-accent">
            NEW BEST!
          </span>
        ) : (
          <span className="font-mono text-sm text-game-fg/50 tabular-nums">
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
        className="rounded-full border border-game-accent/60 bg-game-accent/10 px-10 py-3 font-mono text-base font-semibold tracking-widest text-game-accent transition-colors hover:bg-game-accent/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-game-accent"
      >
        RESTART
      </button>
      <p className="font-mono text-xs text-game-fg/35">or tap anywhere</p>
    </div>
  )
}
