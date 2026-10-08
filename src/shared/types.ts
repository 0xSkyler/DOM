export type MatchMode = 'domain' | 'exact' | 'both';
export type SessionState = 'INITIALIZING' | 'READY' | 'SEARCHING' | 'INSPECTING_SERP' | 'TARGET_FOUND' | 'TARGET_NOT_FOUND' | 'NAVIGATING' | 'SCROLLING' | 'INTERNAL_LINK_TEST' | 'NETWORK_ERROR' | 'CHALLENGED' | 'RESTARTING' | 'WAITING_FOR_ROTATION' | 'STOPPING' | 'STOPPED';
export type ErrorKind = 'CAPTCHA' | 'UNUSUAL_TRAFFIC' | 'ACCESS_DENIED' | 'NAVIGATION_TIMEOUT' | 'PROXY_CONNECTION' | 'NETWORK' | 'SERP_LOADING' | 'EMPTY_RESULTS' | 'UNSUPPORTED_DOM' | 'CANCELLED' | 'RESOURCE_LIMIT';
export interface Settings {
  sessionCount: number; keywords: string; target: string; matchMode: MatchMode;
  rotationSeconds: number; proxyApiUrl: string; searchDepth: number; earlyStop: boolean;
  retryBudget: number; apiRetries: number; apiTimeoutMs: number;
  mode: 'google' | 'controlled'; controlledSearchUrl: string;
  authorizedNavigation: boolean; allowedOrigins: string[]; allowedPathPrefixes: string[];
  scrollPasses: number; scrollStepPx: number; scrollDelayMs: number; navigationDepth: number;
  headless: boolean; device: 'desktop' | 'mobile'; locale: string;
  searchLocation: string; maxMemoryPercent: number; thumbnailSeconds: number;
}
export const DEFAULT_SETTINGS: Settings = {
  sessionCount: 10, keywords: '', target: '', matchMode: 'domain', rotationSeconds: 120,
  proxyApiUrl: 'http://169.58.35.69/api/v1/proxies?sort=latency&format=url',
  searchDepth: 2, earlyStop: false, retryBudget: 1, apiRetries: 2, apiTimeoutMs: 15000,
  mode: 'google', controlledSearchUrl: '', authorizedNavigation: false, allowedOrigins: [],
  allowedPathPrefixes: ['/'], scrollPasses: 2, scrollStepPx: 600, scrollDelayMs: 350,
  navigationDepth: 25, headless: true, device: 'desktop', locale: 'en-US',
  searchLocation: 'Unspecified (proxy-dependent)', maxMemoryPercent: 80, thumbnailSeconds: 15
};
export interface ProxyEntry {
  id: string; server: string; username?: string; password?: string;
  state: 'AVAILABLE' | 'ASSIGNED' | 'RELEASED' | 'FAILED'; sessionId?: string;
}
export interface SessionView {
  id: string; cycle: number; keyword: string; proxyId: string; state: SessionState;
  url: string; lastAction: string; lastError?: string; errorKind?: ErrorKind;
  startedAt: number; rank?: number; retryCount: number; thumbnail?: string;
  pointer?: { x: number; y: number }; navigationCount: number;
}
export interface RankingRecord {
  id?: number; keyword: string; target: string; url: string; title: string;
  organicPosition: number; elementPosition: number; resultPage: number;
  sessionId: string; proxyId: string; device: string; searchLocation: string;
  cycle: number; timestamp: string;
}
export interface Observation {
  sessionId: string; cycle: number; keyword: string;
  outcome: 'FOUND' | 'NOT_FOUND' | 'INCONCLUSIVE' | 'CHALLENGED' | 'ERROR' | 'CANCELLED';
  pagesInspected: number; resultsInspected: number; reason?: string; timestamp: string;
}
export interface Diagnostic { id?: number; timestamp: string; level: 'info' | 'warn' | 'error'; sessionId?: string; cycle?: number; message: string; }
export interface NavigationRecord { sessionId: string; cycle: number; url: string; action: string; timestamp: string; passed: boolean; }
export interface Resources { cpuPercent: number; rssBytes: number; pssBytes?: number; systemUsedBytes: number; systemTotalBytes: number; processCount: number; }
export interface ProxyPoolStatus {
  running: boolean; fetched: number; ready: number; checking: number; assigned: number;
  failed: number; challenged: number; expired: number; pending: number; deferred: number;
  pauseReason?: string; lastFetchAt?: number; error?: string;
}
export interface Snapshot {
  status: 'STOPPED' | 'STARTING' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'WAITING_FOR_PROXIES' | 'ERROR';
  cycle: number; keyword: string; cycleStartedAt?: number; remainingMs: number;
  sessions: SessionView[]; assignedProxies: number; availableProxies: number;
  lastApiFetchAt?: number; rankings: RankingRecord[]; observations: Observation[];
  logs: Diagnostic[]; resources?: Resources; error?: string;
  proxyPool?: ProxyPoolStatus;
}
export interface EventSink {
  session(view: SessionView): void; ranking(record: RankingRecord): void;
  observation(record: Observation): void; log(record: Diagnostic): void;
  navigation(record: NavigationRecord): void;
}
export interface Worker {
  view: SessionView;
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
  preview(): Promise<string | undefined>;
  openResult(url: string, signal: AbortSignal): Promise<void>;
}
export interface BrowserDriver {
  launch(settings: Settings): Promise<void>;
  create(id: string, cycle: number, keyword: string, proxy: ProxyEntry, settings: Settings, sink: EventSink): Promise<Worker>;
  close(): Promise<void>;
}
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void>; }
export interface RepositoryStore {
  saveCycle(cycle: number, keyword: string, startedAt: number, endedAt?: number): void;
  saveRanking(record: RankingRecord): void; saveObservation(record: Observation): void;
  saveDiagnostic(record: Diagnostic): void; saveNavigation(record: NavigationRecord): void;
  saveSession(record: SessionView): void;
  saveAllocation(proxy: ProxyEntry, cycle: number): void;
}
export interface DesktopAPI {
  settings(): Promise<Settings>; saveSettings(settings: Settings): Promise<void>;
  command(command: 'start' | 'stop' | 'pause' | 'resume', settings?: Settings): Promise<void>;
  snapshot(): Promise<Snapshot>; onSnapshot(fn: (snapshot: Snapshot) => void): () => void;
  importKeywords(): Promise<string | undefined>; exportRankings(format: 'csv' | 'xlsx'): Promise<string | undefined>;
  preview(id: string): Promise<string | undefined>; openResult(id: string, url: string): Promise<void>;
}
declare global { interface Window { dom: DesktopAPI; } }
