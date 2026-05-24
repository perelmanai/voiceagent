export function DashboardShell() {
  const bar = "rounded bg-white/[0.06]";
  return (
    <main className="min-h-[100dvh] flex flex-col animate-pulse">
      <header className="flex items-center justify-between gap-6 px-8 pt-7 pb-5">
        <div className={`h-5 w-36 ${bar}`} />
        <div className="flex items-center gap-4">
          <div className={`h-9 w-28 rounded-full ${bar}`} />
          <div className={`h-10 w-28 rounded-full ${bar}`} />
        </div>
      </header>
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-5 px-8 pb-8">
        <div className="flex flex-col gap-4">
          <div className="h-[110px] rounded-2xl bg-white/[0.04]" />
          <div className="flex-1 min-h-[320px] rounded-2xl bg-white/[0.03]" />
        </div>
        <div className="min-h-[320px] rounded-2xl bg-white/[0.03]" />
      </div>
    </main>
  );
}
