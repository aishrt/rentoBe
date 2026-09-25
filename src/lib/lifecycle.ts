let shuttingDown = false;

/** Called on SIGTERM so the health check fails and the load balancer stops sending traffic (plan §13.4). */
export function markShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
