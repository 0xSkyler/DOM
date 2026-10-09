import { useEffect, useRef, useState } from 'react';
import type { BrowserFrame, BrowserInput } from '../shared/types';

// Keep video traffic out of the workspace snapshot and React's application state.
const frames = new Map<string, BrowserFrame>();
const listeners = new Map<string, Set<(frame: BrowserFrame) => void>>();
let connected = false;
function connect(): void {
  if (connected || !window.dom) return;
  connected = true;
  window.dom.onBrowserFrame(frame => {
    frames.delete(frame.sessionId); frames.set(frame.sessionId, frame);
    while (frames.size > 50) frames.delete(frames.keys().next().value!);
    listeners.get(frame.sessionId)?.forEach(listener => listener(frame));
  });
  // A reloaded renderer needs a fresh first frame even if every remote page is idle.
  void window.dom.liveView().catch(() => {});
}

export function LiveBrowser({ id, cycle, interactive = false }: { id: string; cycle: number; interactive?: boolean }) {
  const [frame, setFrame] = useState<BrowserFrame>();
  const [error, setError] = useState('');
  const surface = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const queuedMove = useRef<BrowserInput | undefined>(undefined);
  const moving = useRef(false);
  const lastClick = useRef({ at: 0, x: 0, y: 0, count: 1 });
  const pressed = useRef<BrowserInput['button']>(undefined);
  useEffect(() => {
    connect(); setError('');
    const receive = (next: BrowserFrame) => { if (next.cycle === cycle) setFrame(next); };
    setFrame(frames.get(id)?.cycle === cycle ? frames.get(id) : undefined);
    const subscribers = listeners.get(id) ?? new Set(); subscribers.add(receive); listeners.set(id, subscribers);
    return () => { subscribers.delete(receive); if (!subscribers.size) listeners.delete(id); };
  }, [id, cycle]);

  const send = (input: BrowserInput) => window.dom.browserInput(id, cycle, input).then(() => setError('')).catch(err => setError(String(err.message ?? err)));
  const coordinates = (clientX: number, clientY: number) => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || !frame || !rect.width || !rect.height) return;
    return { x: (clientX - rect.left) / rect.width * frame.viewportWidth, y: (clientY - rect.top) / rect.height * frame.viewportHeight };
  };
  const move = async (input: BrowserInput) => {
    queuedMove.current = input;
    if (moving.current) return;
    moving.current = true;
    try { while (queuedMove.current) { const next = queuedMove.current; queuedMove.current = undefined; await send(next); } }
    finally { moving.current = false; }
  };
  useEffect(() => {
    if (!interactive) return;
    const node = surface.current;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = coordinates(event.clientX, event.clientY);
      if (point) { const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame!.viewportHeight : 1;
        void send({ type: 'wheel', ...point, deltaX: Math.max(-10000, Math.min(10000, event.deltaX * unit)), deltaY: Math.max(-10000, Math.min(10000, event.deltaY * unit)) }); }
    };
    node?.addEventListener('wheel', wheel, { passive: false });
    return () => { node?.removeEventListener('wheel', wheel); };
  }, [interactive, frame?.viewportWidth, frame?.viewportHeight, id, cycle]);

  return <div ref={surface} className={`live-browser${interactive ? ' interactive' : ''}`} aria-label={interactive ? 'Live browser control' : undefined} tabIndex={interactive ? 0 : undefined}
    onContextMenu={event => { if (interactive) event.preventDefault(); }}
    onPointerMove={event => {
      if (!interactive || Date.now() - lastMove.current < 40) return;
      const point = coordinates(event.clientX, event.clientY);
      if (point) { lastMove.current = Date.now(); void move({ type: 'move', ...point }); }
    }}
    onPointerDown={event => {
      if (!interactive) return;
      event.preventDefault(); event.currentTarget.focus();
      const point = coordinates(event.clientX, event.clientY); if (!point) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const prior = lastClick.current;
      const count = Date.now() - prior.at < 350 && Math.hypot(point.x - prior.x, point.y - prior.y) < 5 && prior.count === 1 ? 2 : 1;
      lastClick.current = { at: Date.now(), ...point, count };
      pressed.current = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
      void send({ type: 'down', ...point, button: pressed.current, clickCount: count });
    }}
    onPointerUp={event => {
      if (!interactive || !pressed.current) return;
      const point = coordinates(event.clientX, event.clientY);
      queuedMove.current = undefined;
      if (point) void send({ type: 'up', ...point, button: pressed.current, clickCount: lastClick.current.count });
      pressed.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={event => { const point = coordinates(event.clientX, event.clientY); if (interactive && point && pressed.current) void send({ type: 'up', ...point, button: pressed.current }); pressed.current = undefined; }}>
    {frame ? <img ref={image} src={frame.image} alt={`Live browser ${id}`} draggable={false} /> : <div className="thumbnail-placeholder"><span>Connecting to live browser…</span></div>}
    {error && interactive && <div className="preview-error" role="alert">{error}</div>}
  </div>;
}
