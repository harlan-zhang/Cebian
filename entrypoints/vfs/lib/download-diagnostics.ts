// 临时诊断：仅在 VFS 地址带 ?downloadDebug=1 时启用，不记录路径或文件内容。
const POLL_MS = 100;
const AFTER_DOWNLOAD_MS = 15_000;
const MAX_LONG_TASKS = 20;

function startDownloadDiagnostics() {
  if (new URLSearchParams(location.search).get('downloadDebug') !== '1') return;

  const started = performance.now();
  let previousPhase = started;
  let lastTick = started;
  let maxTimerDelayMs = 0;
  let codeReplacements = 0;
  const longTasks: { startMs: number; durationMs: number }[] = [];
  const phases: { phase: string; elapsedMs: number; phaseMs: number; bytes?: number }[] = [];
  const round = (value: number) => Math.round(value * 10) / 10;
  const mark = (phase: string, bytes?: number) => {
    const now = performance.now();
    const entry = { phase, elapsedMs: round(now - started), phaseMs: round(now - previousPhase), bytes };
    phases.push(entry);
    previousPhase = now;
    console.info('[vfs.download]', JSON.stringify(entry));
  };

  const timer = window.setInterval(() => {
    const now = performance.now();
    maxTimerDelayMs = Math.max(maxTimerDelayMs, now - lastTick - POLL_MS);
    lastTick = now;
  }, POLL_MS);
  const codeObserver = new MutationObserver((records) => { codeReplacements += records.length; });
  const code = document.querySelector('code.hljs');
  if (code) codeObserver.observe(code, { childList: true });
  const tasksSupported = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes.includes('longtask');
  const taskObserver = tasksSupported ? new PerformanceObserver((list) => {
    for (const task of list.getEntries()) {
      longTasks.push({ startMs: round(task.startTime - started), durationMs: round(task.duration) });
    }
    longTasks.sort((a, b) => b.durationMs - a.durationMs);
    longTasks.length = Math.min(longTasks.length, MAX_LONG_TASKS);
  }) : undefined;
  taskObserver?.observe({ type: 'longtask' });

  mark('start:2026-09-22.1');
  return {
    mark,
    finish(outcome: 'dispatched' | 'failed') {
      mark(`handler-finished:${outcome}`);
      // handler 返回只代表交给 Chrome，不代表落盘；继续观察用户报告的转圈结束后卡顿。
      window.setTimeout(() => {
        clearInterval(timer);
        codeObserver.disconnect();
        taskObserver?.disconnect();
        console.info('[vfs.download] report', JSON.stringify({
          observedMs: round(performance.now() - started),
          visibility: document.visibilityState,
          maxTimerDelayMs: round(maxTimerDelayMs),
          codeReplacements,
          longTasks: tasksSupported ? longTasks : null,
          phases,
        }));
      }, AFTER_DOWNLOAD_MS);
    },
  };
}

export { startDownloadDiagnostics };
